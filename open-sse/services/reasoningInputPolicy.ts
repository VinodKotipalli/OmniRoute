import { REGISTRY } from "../config/providerRegistry.ts";
import type { ReasoningTransport } from "../config/providerRegistry.ts";

type JsonRecord = Record<string, unknown>;

const REASONING_TRANSPORTS = new Map<string, ReasoningTransport>();
for (const [id, entry] of Object.entries(REGISTRY)) {
  if (!entry.reasoningTransport) continue;
  REASONING_TRANSPORTS.set(id.toLowerCase(), entry.reasoningTransport);
  if (entry.alias) {
    REASONING_TRANSPORTS.set(entry.alias.toLowerCase(), entry.reasoningTransport);
  }
}

const CHAT_PLAINTEXT_REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "thinking",
  "thought",
] as const;

export type ReasoningInputFormat = "chat" | "responses";

export interface ReasoningStateInspection {
  hasPlaintext: boolean;
  hasOpaque: boolean;
}

export interface ReasoningInputPolicyOptions {
  provider?: string | null;
  preserveEncryptedReasoning?: boolean;
  onIncompatibleReasoning?: "reject" | "drop";
}

export interface ReasoningInputPolicyResult {
  incompatibleReasoning: boolean;
}

export function resolveReasoningTransport(
  provider: string | null | undefined,
  preserveEncryptedReasoning = false
): ReasoningTransport {
  const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const transport = REASONING_TRANSPORTS.get(normalized);
  return transport ?? (preserveEncryptedReasoning ? "opaque" : "plaintext");
}

export function createReasoningTransportIncompatibleError(): Error & {
  statusCode: number;
  errorType: string;
} {
  const error = new Error(
    "Reasoning continuation is not compatible with the selected target"
  ) as Error & { statusCode: number; errorType: string };
  error.statusCode = 400;
  error.errorType = "reasoning_transport_incompatible";
  return error;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isSummaryDetail(record: JsonRecord): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  return (
    type.includes("summary") || record.summary !== undefined || record.summary_text !== undefined
  );
}

function hasPlaintextReasoning(record: JsonRecord): boolean {
  return (
    Array.isArray(record.content) &&
    record.content.some((part) => {
      const value = asRecord(part);
      return value?.type === "reasoning_text" && isNonEmptyString(value.text);
    })
  );
}

function hasChatPlaintextReasoning(record: JsonRecord): boolean {
  if (CHAT_PLAINTEXT_REASONING_FIELDS.some((field) => isNonEmptyString(record[field]))) {
    return true;
  }
  if (!Array.isArray(record.reasoning_details)) return false;
  return record.reasoning_details.some((detail) => {
    const value = asRecord(detail);
    return Boolean(
      value &&
      !isSummaryDetail(value) &&
      (isNonEmptyString(value.text) || isNonEmptyString(value.content))
    );
  });
}

/**
 * Returns only provider-authentic plaintext continuation state. Display summaries
 * are excluded, and a record carrying opaque state is never cross-converted.
 */
export function extractReplayableResponsesReasoningText(value: unknown): string {
  const record = asRecord(value);
  if (!record || record.type !== "reasoning" || hasOpaqueReasoningState(record)) return "";
  if (!Array.isArray(record.content)) return "";

  return record.content
    .map((part) => {
      const content = asRecord(part);
      return content?.type === "reasoning_text" && typeof content.text === "string"
        ? content.text
        : "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function hasOpaqueReasoningState(record: JsonRecord): boolean {
  return (
    isNonEmptyString(record.encrypted_content) ||
    record.signature !== undefined ||
    record.format !== undefined
  );
}

function hasOpaqueReasoningDetail(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  return (
    hasOpaqueReasoningState(record) ||
    ((type.includes("encrypted") || type.includes("opaque")) && isNonEmptyString(record.data))
  );
}

function hasChatOpaqueReasoning(record: JsonRecord): boolean {
  return (
    hasOpaqueReasoningState(record) ||
    (Array.isArray(record.reasoning_details) &&
      record.reasoning_details.some(hasOpaqueReasoningDetail))
  );
}

export function inspectChatReasoning(messages: unknown): ReasoningStateInspection {
  const inspection: ReasoningStateInspection = { hasPlaintext: false, hasOpaque: false };
  if (!Array.isArray(messages)) return inspection;

  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "assistant") continue;
    inspection.hasPlaintext ||= hasChatPlaintextReasoning(record);
    inspection.hasOpaque ||= hasChatOpaqueReasoning(record);
    if (inspection.hasPlaintext && inspection.hasOpaque) break;
  }
  return inspection;
}

export function inspectResponsesReasoning(input: unknown): ReasoningStateInspection {
  const inspection: ReasoningStateInspection = { hasPlaintext: false, hasOpaque: false };
  if (!Array.isArray(input)) return inspection;

  for (const item of input) {
    const record = asRecord(item);
    if (!record || record.type !== "reasoning") continue;
    inspection.hasPlaintext ||= hasPlaintextReasoning(record);
    inspection.hasOpaque ||= hasOpaqueReasoningState(record);
    if (inspection.hasPlaintext && inspection.hasOpaque) break;
  }
  return inspection;
}

function isReasoningCompatible(
  inspection: ReasoningStateInspection,
  transport: ReasoningTransport
): boolean {
  if (!inspection.hasPlaintext && !inspection.hasOpaque) return true;
  if (transport === "plaintext") return !inspection.hasOpaque;
  if (transport === "opaque") return !inspection.hasPlaintext;
  return false;
}

function stripOpaqueFields(record: JsonRecord): void {
  delete record.encrypted_content;
  delete record.signature;
  delete record.format;
  delete record.data;
}

function stripChatReasoningDetails(details: unknown[], transport: ReasoningTransport): unknown[] {
  return details.flatMap((detail) => {
    const record = asRecord(detail);
    if (!record) return [detail];

    const plaintext =
      !isSummaryDetail(record) &&
      (isNonEmptyString(record.text) || isNonEmptyString(record.content));
    const opaque = hasOpaqueReasoningDetail(record);
    if ((!plaintext || transport === "plaintext") && (!opaque || transport === "opaque")) {
      return [detail];
    }

    const next = { ...record };
    if (plaintext && transport !== "plaintext") {
      delete next.text;
      delete next.content;
    }
    if (opaque && transport !== "opaque") stripOpaqueFields(next);
    const remainingKeys = Object.keys(next).filter((key) => key !== "type");
    return remainingKeys.length > 0 ? [next] : [];
  });
}

function dropIncompatibleChatReasoning(
  messages: unknown[],
  transport: ReasoningTransport
): unknown[] {
  return messages.map((message) => {
    const record = asRecord(message);
    if (!record || record.role !== "assistant") return message;
    const next = { ...record };
    if (transport !== "plaintext") {
      for (const field of CHAT_PLAINTEXT_REASONING_FIELDS) delete next[field];
    }
    if (transport !== "opaque") stripOpaqueFields(next);
    if (Array.isArray(record.reasoning_details)) {
      const details = stripChatReasoningDetails(record.reasoning_details, transport);
      if (details.length > 0) next.reasoning_details = details;
      else delete next.reasoning_details;
    }
    return next;
  });
}

function hasDisplaySummary(record: JsonRecord): boolean {
  return record.summary !== undefined || record.summary_text !== undefined;
}

function dropIncompatibleResponsesReasoning(
  record: JsonRecord,
  transport: ReasoningTransport
): JsonRecord | null {
  const next = { ...record };
  if (transport !== "plaintext" && Array.isArray(record.content)) {
    const content = record.content.filter((part) => asRecord(part)?.type !== "reasoning_text");
    if (content.length > 0) next.content = content;
    else delete next.content;
  }
  if (transport !== "opaque") stripOpaqueFields(next);
  const stillActive = hasPlaintextReasoning(next) || hasOpaqueReasoningState(next);
  return stillActive || hasDisplaySummary(next) ? next : null;
}

function sanitizeResponsesInput(
  input: unknown[],
  transport: ReasoningTransport,
  dropIncompatible: boolean
): unknown[] {
  const filtered: unknown[] = [];
  for (const item of input) {
    if (typeof item === "string") continue;
    const record = asRecord(item);
    if (!record) {
      filtered.push(item);
      continue;
    }
    if (record.type === "item_reference") continue;

    if (record.type === "reasoning") {
      const next = dropIncompatible
        ? dropIncompatibleResponsesReasoning(record, transport)
        : { ...record };
      if (!next) continue;
      const hasPlaintext = hasPlaintextReasoning(next);
      const hasOpaque = hasOpaqueReasoningState(next);
      if (!hasPlaintext && !hasOpaque && !hasDisplaySummary(next)) continue;
      if (!hasOpaque && typeof next.id === "string") delete next.id;
      filtered.push(next);
      continue;
    }

    const cloned = { ...record };
    if (typeof cloned.id === "string") delete cloned.id;
    filtered.push(cloned);
  }
  return filtered;
}

/**
 * Applies one protocol-independent compatibility decision before request translation.
 * Plaintext is portable by default; opaque state requires an explicit target declaration.
 * Display summaries are neither inspected nor removed.
 */
export function applyReasoningInputPolicy(
  body: Record<string, unknown>,
  inputFormat: ReasoningInputFormat,
  options: ReasoningInputPolicyOptions = {}
): ReasoningInputPolicyResult {
  const transport = resolveReasoningTransport(options.provider, options.preserveEncryptedReasoning);
  const inspection =
    inputFormat === "responses"
      ? inspectResponsesReasoning(body.input)
      : inspectChatReasoning(body.messages);
  const incompatibleReasoning = !isReasoningCompatible(inspection, transport);

  if (incompatibleReasoning && options.onIncompatibleReasoning !== "drop") {
    return { incompatibleReasoning: true };
  }

  if (inputFormat === "chat") {
    if (incompatibleReasoning && Array.isArray(body.messages)) {
      body.messages = dropIncompatibleChatReasoning(body.messages, transport);
    }
    return { incompatibleReasoning: false };
  }

  if (Array.isArray(body.input) && body.input.length === 0) {
    body.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ];
  }
  if (!Array.isArray(body.input)) return { incompatibleReasoning: false };
  body.input = sanitizeResponsesInput(body.input, transport, incompatibleReasoning);
  return { incompatibleReasoning: false };
}
