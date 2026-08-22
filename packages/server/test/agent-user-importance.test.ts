import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import Fastify from "fastify";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAgentUserImportanceCatalog } from
  "../src/agent-user-importance-catalog.js";
import { registerAgentUserImportanceRoutes } from
  "../src/agent-user-importance-routes.js";
import { createLogicalPageCatalog } from "../src/logical-page-catalog.js";
import { installPrivacyPurgeAuthorization } from
  "../src/live-acquisition-migration.js";
import { normalizeUrl } from "../src/normalize-url.js";
import { installPrivacyPurgeIntentCapabilities } from
  "../src/privacy-purge-intent-capabilities.js";
import { createResourceCommandCatalog } from
  "../src/resource-command-catalog.js";

const directories: string[] = [];
const featureFlags = {
  activityDailyWriter: false,
  activityWindows: false,
  context: true,
  logicalImportance: true,
  resources: true,
  priorityAssessmentWriter: false,
  priorityReaders: false,
  priorityShadow: false,
  research: false,
} as const;

function installSchema26Capabilities(connection: Database.Database): void {
  connection.pragma("foreign_keys = ON");
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeAuthorization(connection);
  installPrivacyPurgeIntentCapabilities(connection);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-agent-importance-"));
  directories.push(directory);
  const databasePath = join(directory, "tabhub.sqlite");
  let now = new Date("2026-08-13T07:10:00.000Z");
  const open = () => createApp({
    databasePath,
    featureFlags,
    logger: false,
    localDevProxySecret: "agent-importance-local",
    clock: () => now,
    migrationClock: () => new Date("2026-08-13T07:00:00.000Z"),
  });
  return {
    databasePath,
    open,
    setNow(value: string) { now = new Date(value); },
  };
}

async function applyThrough(database: Database.Database, version: number) {
  const names = (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= version)
    .sort();
  for (const name of names) {
    database.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.pragma(`user_version = ${version}`);
}

function registerMigrationDependencies(database: Database.Database): void {
  sqliteVec.load(database);
  database.pragma("foreign_keys = ON");
  database.function("tabhub_normalize_url_v2", { deterministic: true }, normalizeUrl);
  database.function("tabhub_migration_now", () => "2026-08-13T07:00:00.000Z");
}

describe("strict agent user importance", () => {
  it("bridges canonical browser rows and replays page/resource mutations across restart", async () => {
    const f = await fixture();
    let app = f.open();
    const url = "https://example.test/deep/page";
    try {
      for (const [browser, source] of [["chrome", "a"], ["edge", "b"]] as const) {
        const ingest = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser,
            tabs: [{
              url: `${url}?utm_source=${source}`,
              title: `${browser} copy`,
              windowId: browser === "chrome" ? 1 : 2,
              index: 0,
            }],
          },
        });
        expect(ingest.statusCode).toBe(200);
      }

      const listed = await app.inject({ method: "GET", url: "/api/tabs?pageSize=10" });
      expect(listed.statusCode).toBe(200);
      const browserRows = listed.json().items as Array<{
        id: number;
        logicalPageId: number;
        browser: string;
        importance: number;
      }>;
      expect(browserRows).toHaveLength(2);
      expect(new Set(browserRows.map(({ id }) => id)).size).toBe(2);
      expect(new Set(browserRows.map(({ logicalPageId }) => logicalPageId)).size).toBe(1);
      const logicalPageId = browserRows[0]!.logicalPageId;
      for (const row of browserRows) {
        const detail = await app.inject({ method: "GET", url: `/api/tabs/${row.id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          id: row.id,
          logicalPageId,
          browser: row.browser,
        });
      }

      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "agent-importance-local" },
      });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const localList = await app.inject({
        method: "GET",
        url: "/api/local/tabs?pageSize=10",
        headers: { cookie, "sec-fetch-site": "same-origin" },
      });
      expect(localList.statusCode).toBe(200);
      expect(localList.json().items.map((row: { logicalPageId: number }) =>
        row.logicalPageId)).toEqual([logicalPageId, logicalPageId]);

      const resources = (await app.inject({ method: "GET", url: "/api/resources" }))
        .json().items as Array<{ resource: { id: number; resourceKey: string } }>;
      const resourceId = resources.find(({ resource }) =>
        resource.resourceKey === "platform:youtube")!.resource.id;
      const pageRequest = {
        subject: { type: "page" as const, logicalPageId },
        value: 3 as const,
        authorizationRef: "explicit-user-request:page-1",
        idempotencyKey: "set-page-importance-1",
      };
      const resourceRequest = {
        subject: { type: "resource" as const, resourceId },
        value: 2 as const,
        authorizationRef: "explicit-user-request:resource-1",
        idempotencyKey: "set-resource-importance-1",
      };

      const pageFirst = await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: pageRequest,
      });
      expect(pageFirst.statusCode).toBe(200);
      expect(pageFirst.json()).toEqual({
        subject: pageRequest.subject,
        value: 3,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
        updatedAt: "2026-08-13T07:10:00.000Z",
      });
      expect(JSON.stringify(pageFirst.json())).not.toMatch(
        /authorizationRef|idempotencyKey|explicit-user-request|set-page/,
      );
      const resourceFirst = await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: resourceRequest,
      });
      expect(resourceFirst.statusCode).toBe(200);
      expect(resourceFirst.json()).toMatchObject({
        subject: resourceRequest.subject,
        value: 2,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
      });

      let inspector = new Database(f.databasePath, { fileMustExist: true });
      try {
        expect(inspector.prepare(`
          SELECT user_importance, recorded_by, record_method, importance_updated_at
          FROM logical_page_preferences WHERE logical_page_id = ?
        `).get(logicalPageId)).toEqual({
          user_importance: 3,
          recorded_by: "agent",
          record_method: "on_behalf_of_user",
          importance_updated_at: "2026-08-13T07:10:00.000Z",
        });
        expect(inspector.prepare(`
          SELECT id, logical_page_id, importance, status FROM tabs ORDER BY id
        `).all()).toEqual(browserRows.map((row) => ({
          id: row.id, logical_page_id: logicalPageId, importance: 3, status: "inbox",
        })));
        expect(inspector.prepare(`
          SELECT user_evaluation, recorded_by, record_method
          FROM resource_preferences WHERE resource_id = ?
        `).get(resourceId)).toEqual({
          user_evaluation: 2,
          recorded_by: "agent",
          record_method: "on_behalf_of_user",
        });
        expect(inspector.prepare(
          "SELECT COUNT(*) FROM agent_user_importance_receipts",
        ).pluck().get()).toBe(2);
        expect(inspector.prepare(`
          SELECT * FROM agent_user_importance_receipts
        `).all().every((row) => {
          const value = JSON.stringify(row);
          return !value.includes(pageRequest.idempotencyKey) &&
            !value.includes(resourceRequest.idempotencyKey) &&
            !value.includes(pageRequest.authorizationRef) &&
            !value.includes(resourceRequest.authorizationRef);
        })).toBe(true);
        expect(inspector.prepare("SELECT COUNT(*) FROM priority_assessments").pluck().get())
          .toBe(0);
        expect(inspector.prepare("SELECT COUNT(*) FROM priority_feedback").pluck().get())
          .toBe(0);
        expect(inspector.prepare("SELECT COUNT(*) FROM page_retention").pluck().get())
          .toBe(0);
        expect(inspector.prepare("SELECT COUNT(*) FROM context_entries").pluck().get())
          .toBe(0);
      } finally {
        inspector.close();
      }

      f.setNow("2026-08-13T08:00:00.000Z");
      expect((await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: pageRequest,
      })).json()).toEqual(pageFirst.json());
      await app.close();
      app = f.open();
      expect((await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: pageRequest,
      })).json()).toEqual(pageFirst.json());
      expect((await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: resourceRequest,
      })).json()).toEqual(resourceFirst.json());
      const sameValueNewKey = await app.inject({
        method: "PUT", url: "/api/agent/user-importance",
        payload: { ...pageRequest, idempotencyKey: "set-page-importance-2" },
      });
      expect(sameValueNewKey.json()).toEqual(pageFirst.json());
      inspector = new Database(f.databasePath, { fileMustExist: true });
      try {
        expect(inspector.prepare(`
          SELECT result_updated_at, created_at
          FROM agent_user_importance_receipts
          ORDER BY created_at DESC, idempotency_key_hash LIMIT 1
        `).get()).toEqual({
          result_updated_at: "2026-08-13T07:10:00.000Z",
          created_at: "2026-08-13T08:00:00.000Z",
        });
        expect(inspector.prepare(`
          SELECT importance_updated_at, updated_at FROM logical_page_preferences
          WHERE logical_page_id=?
        `).get(logicalPageId)).toEqual({
          importance_updated_at: "2026-08-13T07:10:00.000Z",
          updated_at: "2026-08-13T07:10:00.000Z",
        });
      } finally { inspector.close(); }

      for (const conflicting of [
        { ...pageRequest, value: 2 },
        { ...pageRequest, authorizationRef: "different-explicit-request" },
        { ...pageRequest, subject: resourceRequest.subject },
      ]) {
        const response = await app.inject({
          method: "PUT", url: "/api/agent/user-importance", payload: conflicting,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      }

      const receiptCount = () => {
        const state = new Database(f.databasePath, { fileMustExist: true });
        try {
          return state.prepare("SELECT COUNT(*) FROM agent_user_importance_receipts")
            .pluck().get();
        } finally { state.close(); }
      };
      expect(receiptCount()).toBe(3);
      for (const invalid of [
        { ...pageRequest, idempotencyKey: "missing-auth", authorizationRef: undefined },
        { ...pageRequest, idempotencyKey: "forbidden", actor: "user" },
        { ...pageRequest, idempotencyKey: "bad-value", value: 0 },
      ]) {
        const response = await app.inject({
          method: "PUT", url: "/api/agent/user-importance", payload: invalid,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      }
      expect(receiptCount()).toBe(3);

      const missing = await app.inject({
        method: "PUT",
        url: "/api/agent/user-importance",
        payload: {
          ...pageRequest,
          subject: { type: "page", logicalPageId: 999_999 },
          idempotencyKey: "missing-page",
        },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "SUBJECT_NOT_FOUND" });
      expect(receiptCount()).toBe(3);

      const compatibilityMissingAuth = await app.inject({
        method: "PUT",
        url: `/api/agent/resources/${resourceId}/user-evaluation`,
        payload: { evaluation: 1, idempotencyKey: "compat-resource" },
      });
      expect(compatibilityMissingAuth.statusCode).toBe(400);
      expect(receiptCount()).toBe(3);
      const compatibility = await app.inject({
        method: "PUT",
        url: `/api/agent/resources/${resourceId}/user-evaluation`,
        payload: {
          evaluation: 1,
          authorizationRef: "explicit-user-request:compat-resource",
          idempotencyKey: "compat-resource",
        },
      });
      expect(compatibility.statusCode).toBe(200);
      expect(compatibility.json()).toMatchObject({
        subject: { type: "resource", resourceId },
        value: 1,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
      });
      expect(JSON.stringify(compatibility.json())).not.toMatch(
        /authorizationRef|idempotencyKey|explicit-user-request/,
      );

      const clearPage = await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: {
          ...pageRequest, value: null, idempotencyKey: "clear-page-importance",
        },
      });
      const clearResource = await app.inject({
        method: "PUT", url: "/api/agent/user-importance", payload: {
          ...resourceRequest, value: null, idempotencyKey: "clear-resource-importance",
        },
      });
      expect(clearPage.json()).toMatchObject({ subject: pageRequest.subject, value: null });
      expect(clearResource.json()).toMatchObject({
        subject: resourceRequest.subject, value: null,
      });
      inspector = new Database(f.databasePath, { fileMustExist: true });
      try {
        expect(inspector.prepare(`
          SELECT user_importance, recorded_by, record_method
          FROM logical_page_preferences WHERE logical_page_id=?
        `).get(logicalPageId)).toEqual({
          user_importance: null, recorded_by: null, record_method: null,
        });
        expect(inspector.prepare(
          "SELECT DISTINCT importance FROM tabs WHERE logical_page_id=?",
        ).pluck().all(logicalPageId)).toEqual([0]);
        expect(inspector.prepare(`
          SELECT user_evaluation, recorded_by, record_method
          FROM resource_preferences WHERE resource_id=?
        `).get(resourceId)).toEqual({
          user_evaluation: null, recorded_by: null, record_method: null,
        });
        expect(inspector.prepare("SELECT COUNT(*) FROM priority_assessments").pluck().get())
          .toBe(0);
        expect(inspector.prepare("SELECT COUNT(*) FROM resource_priority_assessments")
          .pluck().get()).toBe(0);
        expect(inspector.prepare("SELECT COUNT(*) FROM page_retention").pluck().get())
          .toBe(0);
      } finally { inspector.close(); }
    } finally {
      await app.close();
    }
  }, 60_000);

  it("gates each subject on its personal feature, independent of priority flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-agent-importance-flags-"));
    directories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    const request = {
      value: 1,
      authorizationRef: "explicit-user-request:flags",
      idempotencyKey: "feature-gate",
    };
    for (const scenario of [
      {
        flags: { ...featureFlags, logicalImportance: false, resources: true,
          priorityAssessmentWriter: true, priorityReaders: true, priorityShadow: true },
        subject: { type: "page", logicalPageId: 1 },
        feature: "logicalImportance",
      },
      {
        flags: { ...featureFlags, logicalImportance: true, resources: false,
          priorityAssessmentWriter: true, priorityReaders: true, priorityShadow: true },
        subject: { type: "resource", resourceId: 1 },
        feature: "resources",
      },
    ] as const) {
      const app = createApp({ databasePath, logger: false, featureFlags: scenario.flags });
      try {
        const response = await app.inject({
          method: "PUT", url: "/api/agent/user-importance",
          payload: { ...request, subject: scenario.subject },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          error: "FEATURE_DISABLED", feature: scenario.feature,
        });
        const state = new Database(databasePath, { fileMustExist: true });
        try {
          expect(state.prepare(
            "SELECT COUNT(*) FROM agent_user_importance_receipts",
          ).pluck().get()).toBe(0);
        } finally { state.close(); }
      } finally { await app.close(); }
    }
  });

  it("fails closed on schema 22 before preparing receipt SQL", async () => {
    const connection = new Database(":memory:");
    registerMigrationDependencies(connection);
    try {
      await applyThrough(connection, 22);
      const logicalPages = createLogicalPageCatalog(connection);
      const catalog = createAgentUserImportanceCatalog(connection, {
        schemaVersion: 22,
        logicalImportanceEnabled: true,
        resourcesEnabled: true,
        logicalPages,
      });
      const app = Fastify({ logger: false });
      registerAgentUserImportanceRoutes(app, catalog);
      const response = await app.inject({ method: "PUT", url: "/api/agent/user-importance",
        payload: {
        subject: { type: "page", logicalPageId: 1 },
        value: 1,
        authorizationRef: "explicit-user-request:schema22",
        idempotencyKey: "schema22",
      } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "SCHEMA_UNAVAILABLE",
        requiredSchemaVersion: 23,
        actualSchemaVersion: 22,
      });
      await app.close();
      expect(connection.prepare(`
        SELECT COUNT(*) FROM sqlite_master
        WHERE type='table' AND name='agent_user_importance_receipts'
      `).pluck().get()).toBe(0);
    } finally { connection.close(); }
  });

  it("rolls back domain writes when either side of the receipt boundary fails", async () => {
    const f = await fixture();
    const app = f.open();
    try {
      await app.inject({
        method: "POST", url: "/api/ingest/snapshot",
        payload: { browser: "chrome", tabs: [{
          url: "https://failure.test/page", title: "failure", windowId: 1, index: 0,
        }] },
      });
    } finally { await app.close(); }
    const connection = new Database(f.databasePath, { fileMustExist: true });
    installSchema26Capabilities(connection);
    const clock = () => new Date("2026-08-13T07:20:00.000Z");
    const logicalPages = createLogicalPageCatalog(
      connection,
      clock,
    );
    const resourceCommands = createResourceCommandCatalog(
      connection,
      clock,
    );
    const logicalPageId = connection.prepare("SELECT logical_page_id FROM tabs LIMIT 1")
      .pluck().get() as number;
    try {
      const beforeReceipt = createAgentUserImportanceCatalog(connection, {
        schemaVersion: 23,
        logicalImportanceEnabled: true,
        resourcesEnabled: true,
        clock,
        logicalPages,
        resourceCommands,
      }, { afterDomainMutation: () => { throw new Error("after-domain"); } });
      expect(() => beforeReceipt.change({
        subject: { type: "page", logicalPageId }, value: 3,
        authorizationRef: "explicit-user-request:after-domain",
        idempotencyKey: "after-domain",
      })).toThrow("after-domain");
      expect(connection.prepare(`
        SELECT user_importance FROM logical_page_preferences WHERE logical_page_id=?
      `).pluck().get(logicalPageId)).toBeNull();
      expect(connection.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(0);

      const resourceId = connection.prepare("SELECT id FROM resources ORDER BY id LIMIT 1")
        .pluck().get() as number;
      const resourceFailure = createAgentUserImportanceCatalog(connection, {
        schemaVersion: 23,
        logicalImportanceEnabled: true,
        resourcesEnabled: true,
        clock,
        logicalPages,
        resourceCommands,
      }, { afterDomainMutation: () => { throw new Error("resource-after-domain"); } });
      expect(() => resourceFailure.change({
        subject: { type: "resource", resourceId }, value: 2,
        authorizationRef: "explicit-user-request:resource-after-domain",
        idempotencyKey: "resource-after-domain",
      })).toThrow("resource-after-domain");
      expect(connection.prepare(`
        SELECT user_evaluation FROM resource_preferences WHERE resource_id=?
      `).pluck().get(resourceId)).toBeNull();
      expect(connection.prepare(
        "SELECT COUNT(*) FROM resource_command_receipts",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(0);

      const afterReceipt = createAgentUserImportanceCatalog(connection, {
        schemaVersion: 23,
        logicalImportanceEnabled: true,
        resourcesEnabled: true,
        clock,
        logicalPages,
        resourceCommands,
      }, { afterReceiptInsert: () => { throw new Error("after-receipt"); } });
      expect(() => afterReceipt.change({
        subject: { type: "page", logicalPageId }, value: 2,
        authorizationRef: "explicit-user-request:after-receipt",
        idempotencyKey: "after-receipt",
      })).toThrow("after-receipt");
      expect(connection.prepare(`
        SELECT user_importance FROM logical_page_preferences WHERE logical_page_id=?
      `).pluck().get(logicalPageId)).toBeNull();
      expect(connection.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(0);
    } finally { connection.close(); }
  });

  it("serializes the first receipt check across two database connections", async () => {
    const f = await fixture();
    const app = f.open();
    try {
      await app.inject({ method: "POST", url: "/api/ingest/snapshot", payload: {
        browser: "chrome", tabs: [{
          url: "https://race.test/page", title: "race", windowId: 1, index: 0,
        }],
      } });
    } finally { await app.close(); }

    const first = new Database(f.databasePath, { fileMustExist: true });
    const second = new Database(f.databasePath, { fileMustExist: true });
    installSchema26Capabilities(first);
    installSchema26Capabilities(second);
    second.pragma("busy_timeout = 1");
    const pageId = first.prepare("SELECT logical_page_id FROM tabs LIMIT 1")
      .pluck().get() as number;
    const firstPages = createLogicalPageCatalog(first,
      () => new Date("2026-08-13T07:30:00.000Z"));
    const secondPages = createLogicalPageCatalog(second,
      () => new Date("2026-08-13T07:30:00.000Z"));
    const options = {
      schemaVersion: 23,
      logicalImportanceEnabled: true,
      resourcesEnabled: false,
      clock: () => new Date("2026-08-13T07:30:00.000Z"),
    } as const;
    const request = {
      subject: { type: "page" as const, logicalPageId: pageId },
      value: 3 as const,
      authorizationRef: "explicit-user-request:race",
      idempotencyKey: "race-key",
    };
    const secondCatalog = createAgentUserImportanceCatalog(second, {
      ...options, logicalPages: secondPages,
    });
    let concurrentError: unknown;
    const firstCatalog = createAgentUserImportanceCatalog(first, {
      ...options, logicalPages: firstPages,
    }, {
      afterDomainMutation: () => {
        try { secondCatalog.change(request); } catch (error) { concurrentError = error; }
      },
    });
    try {
      const result = firstCatalog.change(request);
      expect(concurrentError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(secondCatalog.change(request)).toEqual(result);
      expect(first.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(1);
      expect(first.prepare(`
        SELECT user_importance, importance_updated_at
        FROM logical_page_preferences WHERE logical_page_id=?
      `).get(pageId)).toEqual({
        user_importance: 3,
        importance_updated_at: "2026-08-13T07:30:00.000Z",
      });

      const ownerRequest = {
        ...request, value: 2 as const, idempotencyKey: "race-owner-key",
      };
      const competingRequest = {
        ...request, value: 1 as const, idempotencyKey: "race-competing-key",
      };
      concurrentError = undefined;
      const ownerCatalog = createAgentUserImportanceCatalog(first, {
        ...options, logicalPages: firstPages,
      }, {
        afterDomainMutation: () => {
          try {
            secondCatalog.change(competingRequest);
          } catch (error) { concurrentError = error; }
        },
      });
      expect(ownerCatalog.change(ownerRequest)).toMatchObject({ value: 2 });
      expect(concurrentError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(secondCatalog.change(competingRequest)).toMatchObject({ value: 1 });
      expect(first.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(3);
      expect(first.prepare(`
        SELECT user_importance FROM logical_page_preferences WHERE logical_page_id=?
      `).pluck().get(pageId)).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  });
});
