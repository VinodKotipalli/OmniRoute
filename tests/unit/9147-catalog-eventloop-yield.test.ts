import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9147-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-9147-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const CONNECTION_COUNT = 60;
const MODELS_PER_CONNECTION = 12; // ~720 synced models total

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedCatalogScaleDataset() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insertConn = db.prepare(
    `INSERT INTO provider_connections (id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at)
     VALUES (?, 'openai-compatible', 'apikey', ?, ?, 1, ?, ?, ?)`
  );
  const insertModels = db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)`
  );
  const seedTx = db.transaction(() => {
    for (let i = 0; i < CONNECTION_COUNT; i++) {
      const id = `probe-conn-${i}`;
      insertConn.run(id, `probe-connection-${i}`, i, `sk-probe-${i}`, now, now);
      const models = Array.from({ length: MODELS_PER_CONNECTION }, (_, m) => ({
        id: `probe-model-${i}-${m}`,
        name: `Probe Model ${i}-${m}`,
        contextLength: 128000,
      }));
      insertModels.run(`openai-compatible:${id}`, JSON.stringify(models));
    }
  });
  seedTx();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#9147 — catalog build at catalog-scale must not pin the event loop for a long stretch", async () => {
  await seedCatalogScaleDataset();
  const req = new Request("http://localhost/v1/models");
  let settled = false;
  const buildPromise = v1ModelsCatalog.getUnifiedModelsResponse(req).then((res) => {
    settled = true;
    return res;
  });
  let lastTick = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks++;
    if (ticks > 20000) break;
  }
  const res = await buildPromise;
  assert.equal(res.status, 200);
  assert.ok(
    maxGapMs < 150,
    `event loop was blocked for ${maxGapMs.toFixed(1)}ms in a single stretch while building the ` +
      `catalog for ${CONNECTION_COUNT} connections / ${CONNECTION_COUNT * MODELS_PER_CONNECTION} models ` +
      `(${ticks} interleaved ticks observed) — the builder is not yielding to the event loop`
  );
});