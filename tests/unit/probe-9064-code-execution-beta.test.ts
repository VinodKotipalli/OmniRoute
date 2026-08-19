/**
 * Regression for #9064 and its follow-up.
 *
 * #9064: the `anthropic` provider stripped the code-execution and skills betas,
 * so a client sending `container` in dict form was rejected upstream ("must be
 * a string"). The first fix put both flags into the static ANTHROPIC_BETA_BASE.
 *
 * Follow-up: Anthropic rejects EVERY request that carries `skills-2025-10-02`
 * without a `code_execution` tool — `400 "Skills beta requires the
 * code_execution tool to be included in the request"`, on every model — so the
 * static header turned every plain API-key request into a 400. The skills beta
 * is now (a) forwarded when the client negotiated it and (b) appended per
 * request when the outgoing body declares a code_execution tool; it is never in
 * the static header. code-execution-2025-08-25 alone is harmless and stays.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  ANTHROPIC_BETA_API_KEY,
  ANTHROPIC_BETA_CLAUDE_OAUTH,
  ANTHROPIC_SKILLS_BETA,
  FORWARDABLE_CLIENT_BETAS,
  hasCodeExecutionTool,
  mergeClientAnthropicBeta,
} = await import("../../open-sse/config/anthropicHeaders.ts");
const { appendAnthropicBetaHeader } =
  await import("../../open-sse/services/claudeCodeCompatible.ts");

const CODE_EXECUTION = "code-execution-2025-08-25";
const SKILLS = "skills-2025-10-02";

const tokensOf = (header: string) => header.split(",").map((s) => s.trim());

// ── static header ───────────────────────────────────────────────────────────

test("#9064 static ANTHROPIC_BETA_API_KEY includes the code-execution beta", () => {
  assert.ok(tokensOf(ANTHROPIC_BETA_API_KEY).includes(CODE_EXECUTION));
});

test("#9064 follow-up: no static header carries the skills beta (400 without code_execution)", () => {
  assert.equal(ANTHROPIC_SKILLS_BETA, SKILLS);
  assert.ok(!tokensOf(ANTHROPIC_BETA_API_KEY).includes(SKILLS), ANTHROPIC_BETA_API_KEY);
  assert.ok(!tokensOf(ANTHROPIC_BETA_CLAUDE_OAUTH).includes(SKILLS), ANTHROPIC_BETA_CLAUDE_OAUTH);
});

// ── client-negotiated forwarding ────────────────────────────────────────────

test("#9064 mergeClientAnthropicBeta forwards a client-negotiated code-execution beta", () => {
  const out = mergeClientAnthropicBeta(
    ANTHROPIC_BETA_API_KEY,
    `claude-code-20250219,${CODE_EXECUTION}`
  );
  assert.ok(tokensOf(out).includes(CODE_EXECUTION), out);
  assert.ok(FORWARDABLE_CLIENT_BETAS.includes(CODE_EXECUTION));
});

test("#9064 mergeClientAnthropicBeta forwards a client-negotiated skills beta", () => {
  const out = mergeClientAnthropicBeta(ANTHROPIC_BETA_API_KEY, `claude-code-20250219,${SKILLS}`);
  assert.ok(tokensOf(out).includes(SKILLS), out);
  assert.ok(FORWARDABLE_CLIENT_BETAS.includes(SKILLS));
});

test("#9064 follow-up: a client that did not negotiate the skills beta never gets it", () => {
  const out = mergeClientAnthropicBeta(
    ANTHROPIC_BETA_API_KEY,
    "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24"
  );
  assert.ok(!tokensOf(out).includes(SKILLS), out);
});

// ── body-derived injection ──────────────────────────────────────────────────

test("hasCodeExecutionTool recognises the server-side code_execution tool", () => {
  assert.equal(
    hasCodeExecutionTool({ tools: [{ type: "code_execution_20250825", name: "code_execution" }] }),
    true
  );
  assert.equal(
    hasCodeExecutionTool({ tools: [{ type: "code_execution_20260101", name: "x" }] }),
    true
  );
});

test("hasCodeExecutionTool is false for ordinary client tools and malformed bodies", () => {
  assert.equal(
    hasCodeExecutionTool({
      tools: [
        { name: "Bash", input_schema: { type: "object" } },
        { name: "Skill", input_schema: { type: "object" } },
      ],
    }),
    false
  );
  assert.equal(hasCodeExecutionTool({}), false);
  assert.equal(hasCodeExecutionTool({ tools: "nope" }), false);
  assert.equal(hasCodeExecutionTool(null), false);
  assert.equal(hasCodeExecutionTool({ tools: [null, 1, "code_execution"] }), false);
});

test("appending the skills beta to the registry's Anthropic-Beta header dedupes and keeps the base", () => {
  const headers: Record<string, string> = { "Anthropic-Beta": ANTHROPIC_BETA_API_KEY };
  appendAnthropicBetaHeader(headers, ANTHROPIC_SKILLS_BETA);
  appendAnthropicBetaHeader(headers, ANTHROPIC_SKILLS_BETA);
  const keys = Object.keys(headers).filter((k) => k.toLowerCase() === "anthropic-beta");
  assert.equal(keys.length, 1);
  const tokens = tokensOf(headers[keys[0]]);
  assert.equal(tokens.filter((t) => t === SKILLS).length, 1);
  assert.ok(tokens.includes(CODE_EXECUTION));
  assert.ok(tokens.includes("claude-code-20250219"));
});
