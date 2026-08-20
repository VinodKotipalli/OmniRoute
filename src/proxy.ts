import type { NextRequest } from "next/server";
import { runAuthzPipeline } from "./server/authz/pipeline";

// #10627: the proxy runs in its own Next.js runtime and never executes
// instrumentation-node.ts's startup warm-ups, so its FIRST request used to
// trigger a cold `import("@/lib/db/settings")` → native SQLite driver load ON
// the request path. If that addon hangs (see driverFactory's #10627 probe),
// every proxied request stalled indefinitely with 0 bytes and no logs.
// Warm the settings cache here at boot instead: a driver failure now surfaces
// as a logged startup error, and real requests start with a hot cache.
// Fire-and-forget — never blocks proxy initialization, never rejects the
// module (mirrors the `void warmModelCatalogCache()` pattern in
// instrumentation-node.ts).
void import("./lib/db/readCache")
  .then(({ getCachedSettings }) => getCachedSettings())
  .catch((err: unknown) => {
    console.error(
      "[proxy] DB settings warm failed; requests will use default limits:",
      err instanceof Error ? err.message : err
    );
  });

export async function proxy(request: NextRequest) {
  return runAuthzPipeline(request, { enforce: true });
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/home",
    "/home/:path*",
    "/api/:path*",
    "/v1/:path*",
    "/v1",
    "/v1beta/:path*",
    "/v1beta",
    "/chat/:path*",
    "/responses/:path*",
    "/responses",
    "/codex/:path*",
    "/codex",
    "/models",
  ],
};
