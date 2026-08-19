/**
 * Microsoft 365 Copilot (individual / Substrate BizChat) connection helpers.
 *
 * Pure URL / credential / prompt builders for the #4042 individual M365 path.
 * Kept transport-free (no BaseExecutor import — only a type import) so they can
 * be unit-tested without the executor's heavy runtime dependency chain. The
 * access_token rides in the WS query string per the protocol, so any logging of
 * the URL MUST go through redactWsUrl().
 */

import { randomUUID, randomBytes } from "node:crypto";
import type { ProviderCredentials } from "./base.ts";

type JsonRecord = Record<string, unknown>;

/** Individual-tier defaults observed in @skyzea1's #4042 capture. */
export const M365_INDIVIDUAL_DEFAULTS = {
  host: "substrate.office.com",
  source: "officeweb",
  product: "Office",
  agentHost: "Bizchat.FullScreen",
  licenseType: "Starter",
  agent: "web",
  scenario: "OfficeWebPaidConsumerCopilot",
} as const;

/**
 * Education "Starter / OfficeWebIncludedCopilot" tier overrides, captured from the
 * official UI in #6210. Differs from the individual tier only by scenario + isEdu;
 * opt-in via `providerSpecificData.tier="edu"` so the individual path is unchanged.
 */
export const M365_EDU_OVERRIDES = {
  scenario: "OfficeWebIncludedCopilot",
  isEdu: "true",
  licenseType: "Starter",
} as const;

/**
 * Enterprise / "work" (Microsoft 365 Copilot for work) tier overrides (#6334). Enterprise
 * tenants ride the `agent="work"` BizChat surface with the `officeweb` scenario and a
 * Premium license. Opt-in via `providerSpecificData.tier="enterprise"` (alias `"work"`) so
 * the individual and EDU paths are unchanged. A raw `providerSpecificData.agent` override is
 * also honored for tenants that need a different agent value.
 */
export const M365_ENTERPRISE_OVERRIDES = {
  agent: "work",
  scenario: "officeweb",
  licenseType: "Premium",
} as const;

export const M365_DEFAULT_VARIANTS = [
  "EnableMcpServerWidgets",
  "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector",
  "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3",
  "feature.enablechatpages",
  "feature.enableCodeCanvas",
  "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages",
  "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.cwcfluxv3fe",
  "feature.cwcfluxv3fem",
  "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "SingletonEnvOn",
  "EnableComposeWidget",
  "feature.cwcallowedos",
  "feature.EnableMergingPureDeltas",
  "feature.disabledisallowedmsgs",
  "feature.enableCitationsForSynthesisData",
  "feature.EnableConversationShareApis",
  "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableContentApiandDocTypeHtmlInRichAnswers",
  "cdxgrounding_api_v2_rich_web_answers_reference_bottom_force",
  "cdxenablerenderforisocomp",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor",
  "feature.EnableSkipRehydrationForSpeCIdImages",
  "feature.EnablePersonalizationForMSA",
  "agt_bizchat_enableRichResponses",
  "feature.EnableBase64DataInMessageAnnotations",
  "feature.EnableSkipEmittingMessageOnFlush",
  "feature.EnableRemoveEmptySourceAttributions",
  "feature.EnableRemoveStreamingMode",
] as const;

export interface M365ConnectionParams {
  host: string;
  chathubPath: string; // "<user-oid>@<tenant-id>"
  accessToken: string;
  variants?: string;
  /** Tier overrides — when unset, buildWsUrl falls back to the individual defaults. */
  scenario?: string;
  isEdu?: string;
  licenseType?: string;
  agent?: string;
  /** Resolved tier name (#7870) — threads into the chat invocation payload, not just the URL. */
  tier?: "edu" | "enterprise";
}

/** A new 32-hex chat session id (== XRoutingParameterSessionKey == clientrequestid). */
export function newChatSessionId(): string {
  return randomBytes(16).toString("hex");
}

function parsePastedCredential(
  raw: string
): Partial<Pick<M365ConnectionParams, "accessToken" | "chathubPath">> {
  const value = raw.trim();
  const parts: Record<string, string> = {};

  for (const segment of value.split(/[;\n]/)) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const key = segment.slice(0, separator).trim();
    const partValue = segment.slice(separator + 1).trim();
    if (key && partValue) parts[key] = partValue;
  }

  if (/^wss:\/\/substrate\.office\.com\/m365Copilot\/Chathub\//i.test(value)) {
    try {
      const url = new URL(value);
      parts.access_token ||= url.searchParams.get("access_token") || "";
      parts.chathubPath ||= decodeURIComponent(
        url.pathname.split("/m365Copilot/Chathub/")[1] || ""
      );
    } catch {
      // Keep any key/value fields already parsed from the pasted text.
    }
  }

  return {
    accessToken: parts.access_token || parts.accessToken,
    chathubPath: parts.chathubPath || parts.userTenant,
  };
}

/**
 * Read the pasted credential bits. The individual access_token is opaque (JWE),
 * so it is consumed verbatim. The Chathub path (`user@tenant`) is pasted
 * alongside it because it is not derivable from the opaque token.
 */
export function resolveConnectionParams(
  credentials: ProviderCredentials | undefined
): M365ConnectionParams | { error: string } {
  const psd = (credentials?.providerSpecificData ?? {}) as JsonRecord;
  const parsedApiKey =
    typeof credentials?.apiKey === "string" ? parsePastedCredential(credentials.apiKey) : {};
  // A JWT in credentials.accessToken (3 dot-separated parts — the individual-tier
  // token is an opaque JWE with 5) is the freshest copy: the executor refreshes it
  // in place before resolving params, and the framework mutates it after a refresh.
  const credentialsJwt =
    typeof credentials?.accessToken === "string" &&
    credentials.accessToken.split(".").length === 3
      ? credentials.accessToken
      : "";
  const accessToken =
    credentialsJwt ||
    parsedApiKey.accessToken ||
    (typeof credentials?.apiKey === "string" &&
      credentials.apiKey &&
      !credentials.apiKey.includes("access_token=") &&
      credentials.apiKey) ||
    (typeof psd.accessToken === "string" && psd.accessToken) ||
    (typeof psd.access_token === "string" && psd.access_token) ||
    "";
  if (!accessToken) {
    return { error: "Missing M365 Copilot access_token. Paste it as the provider credential." };
  }
  const chathubPath =
    parsedApiKey.chathubPath ||
    (typeof psd.chathubPath === "string" && psd.chathubPath) ||
    (typeof psd.userTenant === "string" && psd.userTenant) ||
    "";
  if (!chathubPath || !chathubPath.includes("@")) {
    return {
      error:
        "Missing M365 Chathub path. Paste the '<user-oid>@<tenant-id>' segment from the WebSocket URL.",
    };
  }
  const host = (typeof psd.host === "string" && psd.host) || M365_INDIVIDUAL_DEFAULTS.host;
  const variants = typeof psd.variants === "string" && psd.variants ? psd.variants : undefined;

  return { host, chathubPath, accessToken, variants, ...resolveTierOverrides(psd) };
}

/**
 * Resolve tier overrides (opt-in). `tier="edu"|"included"` applies the EDU overrides and
 * `tier="enterprise"|"work"` applies the enterprise/work overrides; individual fields
 * (`scenario`/`isEdu`/`licenseType`/`agent`) can also be overridden directly via
 * providerSpecificData. Unset fields fall back to the individual defaults in buildWsUrl.
 * (#6210, #6334)
 */
function resolveTierOverrides(
  psd: JsonRecord
): Pick<M365ConnectionParams, "scenario" | "isEdu" | "licenseType" | "agent" | "tier"> {
  const tier = typeof psd.tier === "string" ? psd.tier.toLowerCase() : "";
  const isEduTier = tier === "edu" || tier === "included";
  const isEnterpriseTier = tier === "enterprise" || tier === "work";
  const psdIsEdu =
    (typeof psd.isEdu === "string" && psd.isEdu) ||
    (typeof psd.isEdu === "boolean" && String(psd.isEdu)) ||
    undefined;
  return {
    scenario:
      (typeof psd.scenario === "string" && psd.scenario) ||
      (isEduTier ? M365_EDU_OVERRIDES.scenario : undefined) ||
      (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.scenario : undefined),
    isEdu: psdIsEdu || (isEduTier ? M365_EDU_OVERRIDES.isEdu : undefined),
    licenseType:
      (typeof psd.licenseType === "string" && psd.licenseType) ||
      (isEduTier ? M365_EDU_OVERRIDES.licenseType : undefined) ||
      (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.licenseType : undefined),
    agent:
      (typeof psd.agent === "string" && psd.agent) ||
      (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.agent : undefined),
    tier: isEduTier ? "edu" : isEnterpriseTier ? "enterprise" : undefined,
  };
}

/**
 * Build the BizChat WebSocket URL. The access_token rides in the query string
 * (per the protocol), so callers must never log the returned URL verbatim — use
 * redactWsUrl() for any logging.
 */
export function buildWsUrl(params: M365ConnectionParams): string {
  const sessionKey = newChatSessionId();
  const query = new URLSearchParams({
    chatsessionid: sessionKey,
    XRoutingParameterSessionKey: sessionKey,
    clientrequestid: sessionKey,
    "X-SessionId": randomUUID(),
    ConversationId: randomUUID(),
    access_token: params.accessToken,
    variants: params.variants ?? M365_DEFAULT_VARIANTS.join(","),
    source: M365_INDIVIDUAL_DEFAULTS.source,
    product: M365_INDIVIDUAL_DEFAULTS.product,
    agentHost: M365_INDIVIDUAL_DEFAULTS.agentHost,
    licenseType: params.licenseType ?? M365_INDIVIDUAL_DEFAULTS.licenseType,
    isEdu: params.isEdu ?? "false",
    agent: params.agent ?? M365_INDIVIDUAL_DEFAULTS.agent,
    scenario: params.scenario ?? M365_INDIVIDUAL_DEFAULTS.scenario,
  });
  return `wss://${params.host}/m365Copilot/Chathub/${params.chathubPath}?${query.toString()}`;
}

/** Strip the access_token from a WS URL so it is safe to log. */
export function redactWsUrl(wsUrl: string): string {
  return wsUrl.replace(/access_token=[^&]*/i, "access_token=REDACTED");
}

// ── OAuth refresh support (#10718 — client ids observed in the browser token
// and M365-Copilot2API) ────────────────────────────────────────────────────
//
// The browser-issued access_token lives ~75 minutes. These helpers redeem a
// stored refresh_token at the Microsoft identity platform (same public client
// the m365.cloud.microsoft web app uses) so the connection self-heals instead
// of requiring a fresh DevTools capture after every expiry.

/** Public client id observed in both the browser token and M365-Copilot2API. */
export const M365_OAUTH_CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";

export const M365_OAUTH_SCOPE =
  "openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read " +
  "https://substrate.office.com/sydney/sydney.readwrite";

/** Refresh lead time — refresh when the current token has less than this left. */
export const M365_REFRESH_LEAD_MS = 5 * 60 * 1000;

type MinimalLog = {
  info?: (tag: string, message: string) => void;
  warn?: (tag: string, message: string) => void;
};

/** Decode a JWT payload WITHOUT verification — exp/tid are routing hints, never authz. */
export function decodeJwtClaims(
  token: string
): { exp?: number; tid?: string; oid?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** True when the token is unreadable, already expired, or inside the refresh lead window. */
export function tokenNeedsRefresh(token: string, leadMs = M365_REFRESH_LEAD_MS): boolean {
  const claims = decodeJwtClaims(token);
  if (!claims?.exp) return true;
  return claims.exp * 1000 <= Date.now() + leadMs;
}

/** The freshest readable access token for a connection (JWT column → apiKey → psd). */
export function currentM365AccessToken(
  credentials: ProviderCredentials | undefined
): string {
  if (
    typeof credentials?.accessToken === "string" &&
    credentials.accessToken.split(".").length === 3
  ) {
    return credentials.accessToken;
  }
  if (typeof credentials?.apiKey === "string") {
    const parsed = parsePastedCredential(credentials.apiKey);
    if (parsed.accessToken && parsed.accessToken.split(".").length === 3) return parsed.accessToken;
    // Opaque (JWE) individual-tier token — still a usable credential, just not refreshable.
    return parsed.accessToken || "";
  }
  const psd = (credentials?.providerSpecificData ?? {}) as JsonRecord;
  if (typeof psd.accessToken === "string") return psd.accessToken;
  if (typeof psd.access_token === "string") return psd.access_token;
  return "";
}

/** The chathub path (`<user-oid>@<tenant-id>`) from wherever it is stored. */
export function currentM365ChathubPath(credentials: ProviderCredentials | undefined): string {
  const psd = (credentials?.providerSpecificData ?? {}) as JsonRecord;
  return (
    (typeof credentials?.apiKey === "string"
      ? parsePastedCredential(credentials.apiKey).chathubPath
      : "") ||
    (typeof psd.chathubPath === "string" && psd.chathubPath) ||
    (typeof psd.userTenant === "string" && psd.userTenant) ||
    ""
  );
}

export interface M365RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Redeem the refresh_token (public client — no secret). MS may rotate the
 * refresh_token; callers MUST persist the returned one when present or the
 * token family dies after the first refresh.
 */
export async function refreshM365AccessToken(
  refreshToken: string,
  tid: string,
  log?: MinimalLog
): Promise<M365RefreshResult | { error: string }> {
  const endpoint = `https://login.microsoftonline.com/${tid || "common"}/oauth2/v2.0/token`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: M365_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: M365_OAUTH_SCOPE,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== "string") {
      const error = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
      log?.warn?.("M365_TOKEN", `refresh_token grant failed: ${error}`);
      return { error };
    }
    log?.info?.("M365_TOKEN", "access token refreshed via refresh_token grant");
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log?.warn?.("M365_TOKEN", `refresh request failed: ${error}`);
    return { error };
  }
}

/** Flatten OpenAI messages into a single prompt (system instructions prepended). */
export function buildPrompt(body: JsonRecord | undefined): string {
  const messages = (body?.messages as Array<JsonRecord>) || [];
  const systemMsgs = messages.filter((m) => m.role === "system");
  const userMsg = messages.filter((m) => m.role === "user").pop();
  const userText =
    typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content ?? "");
  let prompt = "";
  if (systemMsgs.length > 0) {
    const sysText = systemMsgs
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean)
      .join("\n");
    if (sysText) prompt += `[System Instructions]\n${sysText}\n\n`;
  }
  prompt += userText;
  return prompt;
}
