import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #10692: `src/app/(dashboard)/dashboard/providers/page.tsx` is a `"use client"` page.
 * Through `serviceKindIndex → mediaServiceKinds → imageRegistry → aihorde/imageModels →
 * aihordeImageCatalog → safeOutboundFetch → proxyFetch → featureFlags → db/core` it reached
 * the SQLite driver, so the production build tried to bundle `fs`/`net`/`tls` for the browser
 * and failed with 28 `Module not found` errors (`Build App` red for 60 consecutive runs).
 *
 * `serviceKindIndex.ts` already documents the invariant this guard enforces:
 *   "Client-safe: `mediaServiceKinds` only pulls in the pure-data media registries
 *    (no server-only deps)."
 *
 * That was a comment, so nothing stopped #10542 from breaking it. This walks the real
 * static-import graph instead — the same edges the bundler follows. Dynamic `import()` is
 * deliberately NOT followed: deferring a server-only module behind one is exactly how the
 * leak is fixed, and the bundler splits it into a chunk the browser never loads.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Entry points that end up in a client bundle and must stay free of server-only code. */
const CLIENT_SAFE_ENTRIES = [
  "src/lib/providers/serviceKindIndex.ts",
  "open-sse/config/mediaServiceKinds.ts",
];

/** Modules that pull in Node builtins (fs/net/tls) and must never be statically reachable. */
const SERVER_ONLY = [
  "src/lib/db/core.ts",
  "src/lib/db/adapters/driverFactory.ts",
  "src/lib/db/adapters/sqljsAdapter.ts",
  "open-sse/utils/proxyFetch.ts",
];

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];

/** Resolve an import specifier to a repo-relative file, or null when it leaves the repo. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), specifier);
  } else if (specifier.startsWith("@omniroute/open-sse")) {
    const rest = specifier.slice("@omniroute/open-sse".length).replace(/^\//, "");
    base = path.join(REPO_ROOT, "open-sse", rest);
  } else if (specifier.startsWith("@/")) {
    base = path.join(REPO_ROOT, "src", specifier.slice(2));
  } else {
    return null; // npm package — not our graph
  }

  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  // A `.js` specifier on a first-party module means the sibling `.ts` (see #10674).
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(REPO_ROOT, candidate);
    }
  }
  return null;
}

/** Static import/export specifiers only — `import(...)` expressions are intentionally skipped. */
function staticSpecifiers(source: string): string[] {
  const withoutDynamic = source.replace(/\bimport\s*\(/g, "__dynamic_import__(");
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^;'"]*from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;'"]*from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutDynamic.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

/** BFS over static imports; returns the first path reaching a server-only module. */
function findServerOnlyPath(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<string[]> = [[entry]];
  while (queue.length > 0) {
    const trail = queue.shift()!;
    const current = trail[trail.length - 1];
    const absolute = path.join(REPO_ROOT, current);
    if (!fs.existsSync(absolute)) continue;

    for (const specifier of staticSpecifiers(fs.readFileSync(absolute, "utf8"))) {
      const resolved = resolveSpecifier(current, specifier);
      if (!resolved || seen.has(resolved)) continue;
      const next = [...trail, resolved];
      if (SERVER_ONLY.includes(resolved)) return next;
      seen.add(resolved);
      queue.push(next);
    }
  }
  return null;
}

for (const entry of CLIENT_SAFE_ENTRIES) {
  test(`${entry} does not statically reach server-only code`, () => {
    const trail = findServerOnlyPath(entry);
    assert.equal(
      trail,
      null,
      trail
        ? `A client bundle would have to include a server-only module. Static import chain:\n  ${trail.join("\n  → ")}\n` +
            `Break the chain (a dynamic import at the boundary is enough) rather than widening this guard.`
        : ""
    );
  });
}
