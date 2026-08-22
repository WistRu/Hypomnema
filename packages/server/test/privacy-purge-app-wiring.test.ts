import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { createPrivacyPurgeIntentStore } from
  "../src/privacy-purge-intent-capabilities.js";
import { personalAttentionFeatureFlagsOff } from
  "../src/attention-feature-flags.js";

const AT = "2026-08-21T12:00:00.000Z";
const NOW = "2026-08-21T12:00:01.000Z";
const secret = "privacy-purge-app-secret";
const paths: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function path() { const dir = await mkdtemp(join(tmpdir(), "tabhub-purge-app-"));
  paths.push(dir); return join(dir, "tabhub.sqlite"); }
afterEach(async () => { await Promise.all(paths.splice(0).map((value) =>
  rm(value, { recursive: true, force: true }))); });
async function cookie(app: ReturnType<typeof createApp>) {
  const response = await app.inject({ method: "POST", url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": secret } });
  expect(response.statusCode).toBe(204);
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

describe("privacy purge app wiring", () => {
  it("advertises the independent flag and gates only new starts", async () => {
    for (const enabled of [true, false]) {
      const databasePath = await path();
      const seed = openDatabase(databasePath, { migrationClock: () => new Date(AT) });
      seed.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (401, 'https://example.test/401', 'https://example.test/401',
        'https://example.test/401', ?, ?)` ).run(AT, AT);
      seed.close();
      const app = createApp({ databasePath, localDevProxySecret: secret,
        migrationClock: () => new Date(AT), clock: () => new Date(NOW),
        featureFlags: { ...personalAttentionFeatureFlagsOff, privacyPurge: enabled } });
      try {
        const auth = { cookie: await cookie(app), "sec-fetch-site": "same-origin" };
        expect((await app.inject("/api/features")).json().privacyPurge).toBe(enabled);
        const response = await app.inject({ method: "POST", url: "/api/privacy/purges",
          headers: auth, payload: { version: 1, idempotencyKey: "missing",
            target: { kind: "logical_page", logicalPageId: 401 } } });
        expect(response.statusCode).toBe(enabled ? 202 : 409);
        if (!enabled) expect(response.json()).toEqual({ error: "FEATURE_DISABLED",
          feature: "privacyPurge" });
        if (enabled) {
          const started = response.json();
          let state = started.state;
          for (let attempt = 0; attempt < 20 && state === "waiting"; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            state = (await app.inject({ method: "GET",
              url: `/api/privacy/purges/${started.purgeId}`, headers: auth })).json().state;
          }
          expect(state).not.toBe("waiting");
        }
      } finally { await app.close(); }
    }
  });

  it("does not register purge routes below the schema-26 foundation", async () => {
    const app = createApp({ databasePath: await path(), maximumMigrationVersion: 25,
      localDevProxySecret: secret, migrationClock: () => new Date(AT),
      clock: () => new Date(NOW),
      featureFlags: { ...personalAttentionFeatureFlagsOff, privacyPurge: true } });
    try {
      const response = await app.inject({ method: "GET",
        url: `/api/privacy/purges/purge_${"a".repeat(64)}`,
        headers: { cookie: await cookie(app), "sec-fetch-site": "same-origin" } });
      expect(response.statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("recovers an active schema-26 intent while the new-start flag is off", async () => {
    const databasePath = await path();
    const seeded = openDatabase(databasePath, { migrationClock: () => new Date(AT) });
    const intentKey = sha("app-active-recovery");
    try {
      seeded.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (301, 'https://example.test/301', 'https://example.test/301',
        'https://example.test/301', ?, ?)` ).run(AT, AT);
      const subjectGenerationId = Number(seeded.connection.prepare(`SELECT id FROM
        privacy_subject_generations WHERE subject_kind='logical_page'
        AND logical_page_id=301 AND is_active=1`).pluck().get());
      createPrivacyPurgeIntentStore(seeded.connection, { clock: () => new Date(AT) })
        .publishWaiting({ intentKey, idempotencyKeyHash: sha("app-recovery-idem"),
          requestFingerprint: sha("app-recovery-request"),
          target: { kind: "logical_page", subjectGenerationId } });
    } finally { seeded.close(); }
    const app = createApp({ databasePath, localDevProxySecret: secret,
      clock: () => new Date(NOW),
      featureFlags: { ...personalAttentionFeatureFlagsOff, privacyPurge: false } });
    try {
      const auth = { cookie: await cookie(app), "sec-fetch-site": "same-origin" };
      let state = "waiting";
      for (let attempt = 0; attempt < 20 && state === "waiting"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        state = (await app.inject({ method: "GET",
          url: `/api/privacy/purges/purge_${intentKey}`, headers: auth })).json().state;
      }
      expect(state).not.toBe("waiting");
      expect((await app.inject({ method: "POST",
        url: `/api/privacy/purges/purge_${intentKey}/retry`, headers: auth })).statusCode)
        .toBe(409);
      const disabled = await app.inject({ method: "POST", url: "/api/privacy/purges",
        headers: auth, payload: { version: 1, idempotencyKey: "new-disabled",
          target: { kind: "logical_page", logicalPageId: 301 } } });
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json()).toEqual({ error: "FEATURE_DISABLED",
        feature: "privacyPurge" });
    } finally { await app.close(); }
  });
});
