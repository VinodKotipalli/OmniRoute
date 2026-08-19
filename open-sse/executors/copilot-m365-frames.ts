/**
 * Microsoft 365 Copilot (BizChat / Substrate) SignalR-over-WebSocket framing.
 *
 * Pure, transport-free helpers that translate between the OpenAI chat shape and
 * the Substrate BizChat SignalR JSON protocol observed on the individual M365
 * path (`m365.cloud.microsoft/chat` → `wss://substrate.office.com/m365Copilot/
 * Chathub/...`). Keeping these pure lets us unit-test the wire format against the
 * real frame captures contributed in #4042 without opening a live socket — the
 * live round-trip is the separate Rule #18 validation gate for the executor.
 *
 * Protocol (from @skyzea1's #4042 capture):
 *   - JSON messages terminated with the SignalR record separator `\x1e`.
 *   - Handshake: → {"protocol":"json","version":1}  ← {}  → {"type":6}
 *   - Send: type:4 invocation to target "chat" with arguments[0] = { message, ... },
 *     immediately followed by a type:1 target:"Metrics" frame in the SAME socket
 *     write (#10718 — an invocation without its Metrics pair is silently dropped).
 *   - Stream: type:1 target:"update" deltas (bot text at arguments[0].messages[].text,
 *     accumulated — NOT incremental) → isLastUpdate:true → type:2 final → type:3 completion.
 */

/** SignalR record separator (0x1e) terminating every JSON frame. */
export const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** SignalR handshake request — the first frame the client must send. */
export const HANDSHAKE_REQUEST = { protocol: "json", version: 1 } as const;

/** SignalR keepalive ping frame. */
export const KEEPALIVE_PING = { type: 6 } as const;

/**
 * Allowed message types observed in the 2026-08 recapture of the working
 * `m365.cloud.microsoft/chat` client (#10718). The old 11-entry list is no longer
 * seen on the wire — the stale shape gets closed immediately after the type:4.
 */
export const ALLOWED_MESSAGE_TYPES = [
  "Chat",
  "Suggestion",
  "Disengaged",
  "Progress",
  "EndOfRequest",
  "InternalLoaderMessage",
] as const;

/**
 * Enterprise / "work" tier option sets (#7870), captured from @OfflinePing's HAR of the
 * real Microsoft 365 Copilot for work web UI (Discussion #7850). Unlike
 * {@link M365_DEFAULT_OPTION_SETS} (a consumer/MSA set), this omits `enable_msa_user` and
 * the `cwc_*` consumer entries and declares the `enterprise_*`/`bizchat_*` work-surface
 * flags the capture showed — the individual/consumer set never produces a turn on an AAD
 * enterprise tenant because it advertises the wrong account surface.
 */
export const M365_ENTERPRISE_OPTION_SETS = [
  "enterprise_flux_image",
  "enterprise_flux_web",
  "enterprise_flux_work",
  "enterprise_toolbox_with_skdsstore",
  "enterprise_pagination_support",
  "enterprise_flux_work_code_interpreter",
  "enterprise_code_interpreter_citation_fix",
  "bizchat_enable_federated_connectors",
  "at_mention_plugins_enable",
] as const;

/**
 * Additional SignalR message types observed on the enterprise capture beyond
 * {@link ALLOWED_MESSAGE_TYPES} (#7870) — the server actively emits `ReferencesListComplete`
 * on that tenant, a type we did not previously declare as allowed.
 */
export const M365_ENTERPRISE_EXTRA_MESSAGE_TYPES = [
  "ReferencesListComplete",
  "EndOfRequest",
  "MemoryUpdate",
  "TriggerPlugin",
  "AuthError",
  "SwitchRespondingEndpoint",
] as const;

/**
 * Individual / EDU option sets from the 2026-08 recapture (#10718) — 14 entries.
 * The previous 25-entry consumer/MSA set (enable_msa_user, pdnascan, cwc_code_*,
 * …) is no longer observed on the wire and belongs to the shape the substrate
 * now drops silently.
 */
export const M365_DEFAULT_OPTION_SETS = [
  "search_result_progress_messages_with_search_queries",
  "update_textdoc_response_after_streaming",
  "deepleo_networking_timeout_10minutes_canmore",
  "cwc_flux_image",
  "cwcfluxgptv",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
  "cwc_fileupload_odb",
  "update_memory_plugin",
  "add_custom_instructions",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "enable_batch_token_processing",
  "enable_gg_gpt",
] as const;

/** Append the record separator to a JSON-serializable frame. */
export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj) + RECORD_SEPARATOR;
}

/** Serialized handshake request frame. */
export function handshakeFrame(): string {
  return encodeFrame(HANDSHAKE_REQUEST);
}

/** Serialized keepalive ping frame. */
export function keepaliveFrame(): string {
  return encodeFrame(KEEPALIVE_PING);
}

/**
 * #10718 — the browser follows the type:4 chat invocation with this type:1
 * target:"Metrics" frame in the SAME socket write. Sending the invocation alone
 * gets it silently ignored (no update frames at all), so the executor must
 * concatenate `metricsFrame()` onto the invocation payload.
 */
export const CHAT_METRICS_FRAME = {
  arguments: [
    {
      Timestamps: {
        ConnectionEstablished: "",
        ConnectionStart: "",
        UserInputStart: "",
        UserInputSubmit: "",
      },
    },
  ],
  target: "Metrics",
  type: 1,
} as const;

/** Serialized Metrics follow-up frame (see {@link CHAT_METRICS_FRAME}). */
export function metricsFrame(): string {
  return encodeFrame(CHAT_METRICS_FRAME);
}

/**
 * Split a raw socket buffer into complete `\x1e`-terminated frames, returning any
 * trailing partial frame as `rest` so it can be prepended to the next chunk.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(RECORD_SEPARATOR);
  // The last element is either "" (buffer ended on a separator) or a partial frame.
  const rest = parts.pop() ?? "";
  const frames = parts.filter((p) => p.length > 0);
  return { frames, rest };
}

/** Safely JSON.parse a single frame body; returns null on malformed input. */
export function parseFrame(frame: string): Record<string, unknown> | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A SignalR handshake response is `{}` on success, or `{ error: "..." }` on
 * failure. Returns the error string, or null when the handshake succeeded.
 */
export function handshakeError(frame: Record<string, unknown> | null): string | null {
  if (!frame) return null;
  const err = frame.error;
  return typeof err === "string" && err.length > 0 ? err : null;
}

export interface ChatInvocationOptions {
  text: string;
  /** Per-invocation trace id (GUID). */
  traceId: string;
  /** Client correlation id; defaults to {@link ChatInvocationOptions.traceId}. */
  clientCorrelationId?: string;
  /** Per-session id (GUID, == the WS URL X-SessionId query). */
  sessionId: string;
  /** Per-request id (== the WS URL chatsessionid/clientrequestid query). */
  requestId: string;
  /**
   * Conversation id — MUST match the ConversationId query of the WS URL the
   * invocation rides on (#10718: the server cross-checks the two).
   */
  conversationId: string;
  /** BCP-47 locale echoed in message.locale; defaults to "en-us". */
  locale?: string;
  /** IANA time zone for message.locationInfo; defaults to "UTC". */
  timeZone?: string;
  /** Hour offset for message.locationInfo; defaults to 0. */
  timeZoneOffset?: number;
  /** Whether this is the first turn of the conversation. */
  isStartOfSession?: boolean;
  /** Tier-specific option flags; defaults to {@link M365_DEFAULT_OPTION_SETS}. */
  optionsSets?: string[];
  tone?: string;
  /** Tier-specific allowed message types; defaults to {@link ALLOWED_MESSAGE_TYPES}. */
  allowedMessageTypes?: readonly string[];
  /**
   * Tier-specific disconnect behavior sent in the type:4 chat invocation. The work
   * surface rejects any value other than exactly "continue" (#8971), so the
   * enterprise tier sends it; the 2026-08 recapture shows the individual/EDU
   * surface omits the key entirely, so it is left out unless set (#10718).
   */
  disconnectBehavior?: string;
}

/**
 * Resolve the tier-specific `optionsSets` / `tone` / `allowedMessageTypes` overrides for
 * the `type:4` chat invocation (#7870). Mirrors how `resolveConnectionParams`/`buildWsUrl`
 * already branch on tier for the WS URL — this is the request-payload counterpart so an
 * enterprise tier actually changes what is sent, not just where it is sent.
 */
export function resolveChatInvocationOverrides(tier: string | undefined): {
  optionsSets: string[];
  tone: string;
  allowedMessageTypes: readonly string[];
  disconnectBehavior: string | undefined;
} {
  if (tier === "enterprise") {
    return {
      optionsSets: [...M365_ENTERPRISE_OPTION_SETS],
      tone: "Magic",
      allowedMessageTypes: [...ALLOWED_MESSAGE_TYPES, ...M365_ENTERPRISE_EXTRA_MESSAGE_TYPES],
      disconnectBehavior: "continue",
    };
  }
  return {
    optionsSets: [...M365_DEFAULT_OPTION_SETS],
    // #10718 — the 2026-08 recapture sends tone:"magic" (lowercase) on the
    // individual/EDU surface; the old "" default is part of the dropped shape.
    tone: "magic",
    allowedMessageTypes: ALLOWED_MESSAGE_TYPES,
    // Omitted entirely on the individual/EDU wire (see ChatInvocationOptions).
    disconnectBehavior: undefined,
  };
}

/**
 * BizChat exposes several models selected by the `tone` field of the `type:4` chat
 * invocation (#7872, values confirmed against a real enterprise tenant in #7850). Each
 * tone-selected variant is registered as its own model id; the bare `copilot-m365` id is
 * intentionally absent here so it keeps the tier default tone (`Magic` on enterprise, `magic`
 * otherwise) resolved by {@link resolveChatInvocationOverrides}.
 */
export const M365_MODEL_TONE_MAP: Readonly<Record<string, string>> = {
  "copilot-m365-claude-opus": "Claude_Opus",
  "copilot-m365-gpt-5-6-reasoning": "Gpt_5_6_Reasoning",
  "copilot-m365-gpt-5-5-chat": "Gpt_5_5_Chat",
};

/**
 * Resolve the `tone` for a requested model id, or `undefined` when the id is the bare
 * `copilot-m365` / unknown — callers then fall back to the tier default tone. Model-driven
 * tone takes precedence over the tier default (see the executor wiring).
 */
export function resolveToneForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return M365_MODEL_TONE_MAP[model];
}

/**
 * Build the `type:4` chat invocation frame body (not yet `\x1e`-terminated).
 * Mirrors the argument shape recaptured from a working `m365.cloud.microsoft/chat`
 * client in 2026-08 (#10718). Notable differences from the pre-#10718 shape: a
 * populated `clientInfo` + `productThreadType:"Office"`, a `conversationId`
 * matching the WS URL query, a rich `message` object, and no
 * `spokenTextMode` / `extraExtensionParameters` / `isSbsSupported` /
 * `renderReferencesBehindEOS` / `disconnectBehavior` — none of those are still
 * observed on the wire, and the stale shape gets closed immediately after the
 * invocation.
 */
export function buildChatInvocation(opts: ChatInvocationOptions): Record<string, unknown> {
  return {
    type: 4,
    target: "chat",
    invocationId: "0",
    arguments: [
      {
        allowedMessageTypes: opts.allowedMessageTypes
          ? [...opts.allowedMessageTypes]
          : [...ALLOWED_MESSAGE_TYPES],
        clientCorrelationId: opts.clientCorrelationId ?? opts.traceId,
        clientInfo: {
          clientAppName: "Office",
          clientPlatform: "mcmcopilot-web",
        },
        conversationId: opts.conversationId,
        isStartOfSession: opts.isStartOfSession ?? true,
        message: {
          adaptiveCards: [],
          attachments: null,
          author: "user",
          clientPreferences: {},
          entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
          experienceType: "Default",
          inputMethod: "Keyboard",
          locale: opts.locale ?? "en-us",
          locationInfo: {
            timeZone: opts.timeZone ?? "UTC",
            timeZoneOffset: opts.timeZoneOffset ?? 0,
          },
          messageType: "Chat",
          requestId: opts.requestId,
          text: opts.text,
        },
        options: {},
        optionsSets: opts.optionsSets ?? [...M365_DEFAULT_OPTION_SETS],
        plugins: [],
        productThreadType: "Office",
        sessionId: opts.sessionId,
        sliceIds: [],
        source: "officeweb",
        streamingMode: "ConciseWithPadding",
        threadLevelGptId: {},
        tone: opts.tone ?? "magic",
        toolChoice: null,
        traceId: opts.traceId,
        // #8971 keeps "continue" for the enterprise tier; the individual/EDU wire
        // omits the key, so only include it when actually set (#10718).
        ...(opts.disconnectBehavior ? { disconnectBehavior: opts.disconnectBehavior } : {}),
      },
    ],
  };
}

/** True when the frame is a SignalR invocation/streamItem (`type:1`) update. */
export function isUpdateFrame(frame: Record<string, unknown> | null): boolean {
  return !!frame && frame.type === 1 && frame.target === "update";
}

/** True when the frame is the SignalR completion (`type:3`) for the chat invocation. */
export function isCompletionFrame(frame: Record<string, unknown> | null): boolean {
  return !!frame && frame.type === 3;
}

/** True when an update frame is flagged as the last update of the turn. */
export function isLastUpdate(frame: Record<string, unknown> | null): boolean {
  if (!isUpdateFrame(frame)) return false;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  return first?.isLastUpdate === true;
}

/**
 * Extract the accumulated bot text from a `type:1` update frame, reading the last
 * bot-authored message's `.text`. Returns null when the frame carries no bot text
 * (Progress/Suggestion/ReferencesListComplete updates, throttling-only frames, etc.).
 */
export function extractBotText(frame: Record<string, unknown> | null): string | null {
  if (!isUpdateFrame(frame)) return null;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  const messages = first?.messages;
  if (!Array.isArray(messages)) return null;
  // Prefer the last bot-authored message with non-empty text.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m) continue;
    const author = m.author;
    const text = m.text;
    if (m.messageType === "Progress" || m.contentType === "EarlyProgress") continue;
    if ((author === "bot" || author === undefined) && typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return null;
}

/**
 * BizChat update frames carry the FULL accumulated answer each time, not an
 * incremental delta. Given the previously-emitted text and the new accumulated
 * text, return the new suffix to stream. When the new text does not extend the
 * previous (a replace/rewrite), the whole new text is returned so nothing is lost.
 */
export function incrementalDelta(previous: string, next: string): string {
  if (!next) return "";
  if (next === previous) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

/**
 * Extract an incremental `writeAtCursor` delta from a `type:1` update frame. The EDU /
 * GPT-5.5 path (`OfficeWebIncludedCopilot`, feature.bizchatfluxv3) streams response text
 * as `arguments[0].writeAtCursor` INCREMENTS instead of only accumulated `messages[].text`
 * snapshots. Returns null when the frame carries no writeAtCursor delta. (#6210)
 */
export function extractWriteAtCursor(frame: Record<string, unknown> | null): string | null {
  if (!isUpdateFrame(frame)) return null;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  const wac = first?.writeAtCursor;
  return typeof wac === "string" && wac.length > 0 ? wac : null;
}

/**
 * Extract the final answer from a `type:2` invocation-result frame
 * (`item.result.message`). Used as a last-resort fallback when a turn emitted no
 * streamed content (some EDU turns only surface the answer here). (#6210)
 */
export function extractFinalResultMessage(frame: Record<string, unknown> | null): string | null {
  if (!frame || frame.type !== 2) return null;
  const item = frame.item as Record<string, unknown> | undefined;
  const result = item?.result as Record<string, unknown> | undefined;
  const message = result?.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * Fold a single incoming frame into the running bot answer, returning the suffix to
 * stream (`delta`) and the new accumulated text (`next`). Handles both wire formats:
 * `messages[].text` snapshots are the full accumulated answer (diffed via
 * {@link incrementalDelta}), while `writeAtCursor` frames are incremental and are
 * appended. Non-content frames leave the state unchanged. (#6210)
 */
export function accumulateBotContent(
  previous: string,
  frame: Record<string, unknown> | null
): { delta: string; next: string } {
  const snapshot = extractBotText(frame);
  if (snapshot) {
    return { delta: incrementalDelta(previous, snapshot), next: snapshot };
  }
  const wac = extractWriteAtCursor(frame);
  if (wac) {
    return { delta: wac, next: previous + wac };
  }
  return { delta: "", next: previous };
}
