import test from "node:test";
import assert from "node:assert/strict";

type Connection = {
  id: string;
  provider: string;
  authType: string;
};

const CONNECTIONS: Connection[] = [
  { id: "conn1", provider: "gemini", authType: "oauth" },
  { id: "conn2", provider: "cursor", authType: "oauth2" },
  { id: "conn3", provider: "openai", authType: "api_key" },
];

function makeResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const orig = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = (chunk: Uint8Array | string) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return {
    optsWithGlobals: () => ({ output, quiet: output !== "table" }),
  } as unknown as import("commander").Command;
}

test("runOAuthStatus filtra apenas conexões oauth/oauth2", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.ok(url.includes("/api/providers"));
    return Promise.resolve(makeResp({ providers: CONNECTIONS }));
  }) as unknown as typeof fetch;

  const { runOAuthStatus } = await import("../../bin/cli/commands/oauth.mjs");
  const out = await captureStdout(() => runOAuthStatus({}, makeCmd()));

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every((c: Connection) => c.authType === "oauth" || c.authType === "oauth2"));
});

test("runOAuthStatus filtra por provider", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      makeResp({ providers: CONNECTIONS.filter((c) => c.provider === "gemini") })
    );
  }) as unknown as typeof fetch;

  const { runOAuthStatus } = await import("../../bin/cli/commands/oauth.mjs");
  await captureStdout(() => runOAuthStatus({ provider: "gemini" }, makeCmd()));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("provider=gemini"));
});

test("runOAuthStatus consumes the connections envelope", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.ok(url.includes("/api/providers"));
    return Promise.resolve(makeResp({ connections: CONNECTIONS }));
  }) as unknown as typeof fetch;

  try {
    const { runOAuthStatus } = await import("../../bin/cli/commands/oauth.mjs");
    const out = await captureStdout(() => runOAuthStatus({}, makeCmd()));
    const parsed = JSON.parse(out);
    assert.deepEqual(
      parsed.map((connection: { id: string }) => connection.id),
      ["conn1", "conn2"]
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("runOAuthRevoke com --yes chama endpoint de revogação", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = opts?.method ?? "GET";
    return Promise.resolve(makeResp({}));
  }) as unknown as typeof fetch;

  const out = await captureStdout(async () => {
    const { runOAuthRevoke } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthRevoke({ provider: "gemini", yes: true }, makeCmd());
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/oauth/gemini/revoke"));
  assert.equal(capturedMethod, "POST");
  assert.ok(out.includes("Revoked"));
});

test("runOAuthRevoke com connectionId usa DELETE no provider", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = opts?.method ?? "GET";
    return Promise.resolve(makeResp({}));
  }) as unknown as typeof fetch;

  const out = await captureStdout(async () => {
    const { runOAuthRevoke } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthRevoke({ provider: "gemini", connectionId: "conn1", yes: true }, makeCmd());
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/providers/conn1"));
  assert.equal(capturedMethod, "DELETE");
  assert.ok(out.includes("Revoked"));
});

test("runOAuthStart flow=import chama endpoint de import", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = opts?.method ?? "GET";
    return Promise.resolve(makeResp({ count: 3 }));
  }) as unknown as typeof fetch;

  const out = await captureStdout(async () => {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "cursor" }, makeCmd());
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/oauth/cursor/import"));
  assert.equal(capturedMethod, "POST");
  assert.ok(out.includes("3"));
});

test("runOAuthStart flow=import com --import-from-system usa auto-import", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ count: 1 }));
  }) as unknown as typeof fetch;

  const out = await captureStdout(async () => {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "zed", importFromSystem: true }, makeCmd());
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/oauth/zed/auto-import"));
  assert.ok(out.includes("1"));
});

test("runOAuthStart rejects retired Windsurf instead of starting a public OAuth flow", async () => {
  const origFetch = globalThis.fetch;
  const origExit = process.exit;
  let fetchCalled = false;
  let exitCode: number | undefined;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.reject(new Error("Windsurf must not start a public OAuth request"));
  }) as typeof fetch;
  process.exit = ((code?: number | string | null): never => {
    exitCode = typeof code === "number" ? code : undefined;
    throw new Error(`exit ${code}`);
  }) as typeof process.exit;

  try {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await assert.rejects(runOAuthStart({ provider: "windsurf" }, makeCmd()), /exit 2/);
  } finally {
    globalThis.fetch = origFetch;
    process.exit = origExit;
  }

  assert.equal(exitCode, 2);
  assert.equal(fetchCalled, false);
});

test("providers lista provedores OAuth conhecidos", async () => {
  const { PROVIDERS_WITH_OAUTH_TEST } = await import("../../bin/cli/commands/oauth.mjs").catch(
    () => ({ PROVIDERS_WITH_OAUTH_TEST: null })
  );
  void PROVIDERS_WITH_OAUTH_TEST;
  // validate via runOAuthStart unknown provider exits
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number | string | null): never => {
    exitCode = typeof code === "number" ? code : undefined;
    throw new Error("exit");
  }) as typeof process.exit;

  try {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "unknown_provider_xyz" }, makeCmd()).catch(() => {});
  } catch {
    // expected
  }

  process.exit = origExit;
  assert.equal(exitCode, 2);
});
