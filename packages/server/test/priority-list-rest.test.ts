import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from
  "../src/attention-feature-flags.js";
import { createPriorityFeatureCatalog } from
  "../src/priority-feature-catalog.js";
import { openDatabase } from "../src/database.js";
import { installPrivacyPurgeAuthorization } from
  "../src/live-acquisition-migration.js";
import { installPrivacyPurgeIntentCapabilities } from
  "../src/privacy-purge-intent-capabilities.js";
import { createResourceReadCatalog } from "../src/resource-read-catalog.js";

const at = "2026-08-13T12:00:00.000Z";

function installSchema26Capabilities(connection: Database.Database): void {
  connection.pragma("foreign_keys = ON");
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeAuthorization(connection);
  installPrivacyPurgeIntentCapabilities(connection);
}

function databaseSnapshot(databasePath: string): string {
  const database = openDatabase(databasePath);
  const connection = database.connection;
  try {
    const tables = connection.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).pluck().all() as string[];
    return JSON.stringify(Object.fromEntries(tables.map((table) => [table,
      connection.prepare(`SELECT * FROM ${table}`).all()])));
  } finally {
    database.close();
  }
}

function insertPageOutcome(
  connection: Database.Database,
  input: {
    id: number;
    logicalPageId: number;
    kind?: "assessment" | "exclusion";
    score?: number;
    fingerprint: string;
    needsReview?: boolean;
  },
): void {
  const fingerprint = input.fingerprint;
  if (input.kind === "exclusion") {
    connection.prepare(`INSERT INTO priority_exclusions (
      id, logical_page_id, reason, detail_json, ruleset_id, ruleset_version,
      feature_fingerprint, revision, evaluated_at
    ) VALUES (?, ?, 'policy_excluded', '{}', 1, 1, ?, 1, ?)`)
      .run(input.id, input.logicalPageId, fingerprint, at);
    return;
  }
  const score = input.score ?? 40;
  const band = score >= 85 ? "critical" : score >= 60 ? "high"
    : score >= 25 ? "medium" : "low";
  connection.prepare(`INSERT INTO priority_assessments (
    id, logical_page_id, agent_score, agent_band, confidence, needs_review,
    reasons_json, missing_signals_json, ruleset_id, ruleset_version,
    feature_fingerprint, assessment_method, model_provenance_json, revision,
    evaluated_at
  ) VALUES (?, ?, ?, ?, 0.9, ?, '[]', '[]', 1, 1, ?, 'rule', NULL, 1, ?)`)
    .run(input.id, input.logicalPageId, score, band,
      input.needsReview ? 1 : 0, fingerprint, at);
}

function insertResourceOutcome(
  connection: Database.Database,
  input: {
    id: number;
    resourceId: number;
    kind?: "assessment" | "exclusion";
    score?: number;
    fingerprint: string;
    needsReview?: boolean;
  },
): void {
  if (input.kind === "exclusion") {
    connection.prepare(`INSERT INTO resource_priority_exclusions (
      id, resource_id, reason, detail_json, ruleset_id, ruleset_version,
      feature_fingerprint, revision, evaluated_at
    ) VALUES (?, ?, 'policy_excluded', '{}', 1, 1, ?, 1, ?)`)
      .run(input.id, input.resourceId, input.fingerprint, at);
    return;
  }
  const score = input.score ?? 40;
  const band = score >= 85 ? "critical" : score >= 60 ? "high"
    : score >= 25 ? "medium" : "low";
  connection.prepare(`INSERT INTO resource_priority_assessments (
    id, resource_id, agent_score, agent_band, confidence, needs_review,
    reasons_json, missing_signals_json, ruleset_id, ruleset_version,
    feature_fingerprint, assessment_method, model_provenance_json, revision,
    evaluated_at
  ) VALUES (?, ?, ?, ?, 0.9, ?, '[]', '[]', 1, 1, ?, 'rule', NULL, 1, ?)`)
    .run(input.id, input.resourceId, score, band,
      input.needsReview ? 1 : 0, input.fingerprint, at);
}

describe("priority list REST ordering", () => {
  it("orders canonical My importance before pagination and stays opt-in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-list-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        logicalImportance: true,
        priorityPersonalization: true,
        priorityReaders: true,
      },
    });
    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: ["first", "second", "third"].map((slug, index) => ({
            url: `https://${slug}.test/`,
            title: slug,
            windowId: 1,
            index,
          })),
        },
      });
      const defaultBefore = (await app.inject({
        method: "GET", url: "/api/tabs?pageSize=10",
      })).json().items.map((item: { id: number }) => item.id);
      const items = (await app.inject({
        method: "GET", url: "/api/tabs?pageSize=10",
      })).json().items as Array<{ id: number; title: string }>;
      const byTitle = new Map(items.map((item) => [item.title, item.id]));
      for (const [title, importance] of [["first", 1], ["second", 0], ["third", 3]] as const) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/tabs/${byTitle.get(title)}`,
          payload: { importance },
        });
        expect(response.statusCode).toBe(200);
      }

      const page = await app.inject({
        method: "GET",
        url: "/api/tabs?priority_mode=my&page=2&pageSize=1",
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        items: [{ title: "first", importance: 1 }],
        page: 2,
        pageSize: 1,
        total: 3,
      });
      for (const direction of ["asc", "desc"] as const) {
        const sorted = await app.inject({ method: "GET",
          url: `/api/tabs?priority_mode=my&sort_by=title&sort_direction=${direction}&pageSize=10` });
        expect(sorted.statusCode).toBe(200);
        expect(sorted.json().items.map((item: { title: string }) => item.title))
          .toEqual(["third", "first", "second"]);
      }
      const defaultAfter = (await app.inject({
        method: "GET", url: "/api/tabs?pageSize=10",
      })).json().items.map((item: { id: number }) => item.id);
      expect(defaultAfter).toEqual(defaultBefore);
      expect((await app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ priorityPersonalization: true });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps normalized, raw, and final-ID tails deterministic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-tails-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"), logger: false,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        context: true, logicalImportance: true, resources: true,
        priorityPersonalization: true, priorityReaders: true,
      },
      localDevProxySecret: "priority-tails-secret",
    });
    try {
      for (const [browser, urls] of [
        ["Beta", ["https://tail-beta.test/"]],
        ["ALPHA", ["https://tail-alpha-upper.test/"]],
        ["alpha", ["https://tail-alpha-1.test/", "https://tail-alpha-2.test/"]],
      ] as const) {
        expect((await app.inject({ method: "POST", url: "/api/ingest/snapshot",
          payload: { browser, tabs: urls.map((url, index) => ({
            url, title: "same title", windowId: 1, index,
          })) } })).statusCode).toBe(200);
      }
      const tabs = (await app.inject({ method: "GET", url: "/api/tabs?pageSize=20" }))
        .json().items as Array<{ id: number; browser: string; url: string }>;
      const beta = tabs.find((item) => item.browser === "Beta")!;
      expect((await app.inject({ method: "PATCH", url: `/api/tabs/${beta.id}`,
        payload: { importance: 3 } })).statusCode).toBe(200);
      const expectedTabIds = [beta.id,
        tabs.find((item) => item.browser === "ALPHA")!.id,
        ...tabs.filter((item) => item.browser === "alpha")
          .map((item) => item.id).sort((left, right) => left - right)];
      for (const direction of ["asc", "desc"] as const) {
        const response = await app.inject({ method: "GET",
          url: `/api/tabs?priority_mode=my&sort_by=title&sort_direction=${direction}&pageSize=20` });
        expect(response.statusCode).toBe(200);
        expect(response.json().items.map((item: { id: number }) => item.id))
          .toEqual(expectedTabIds);
      }

      const bootstrap = await app.inject({ method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "priority-tails-secret" } });
      const headers = { cookie: String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!,
        "sec-fetch-site": "same-origin" };
      for (const [index, resourceKey] of ["platform:tail-beta",
        "platform:tail-alpha-upper", "platform:tail-alpha"].entries()) {
        expect((await app.inject({ method: "POST", url: "/api/resources/commands",
          headers, payload: { kind: "create", resourceKey, name: "tail tie",
            resourceKind: "platform", accessClass: "public",
            idempotencyKey: `tail-${index}` } })).statusCode).toBe(200);
      }
      const setup = new Database(join(directory, "tabhub.sqlite"));
      try {
        installSchema26Capabilities(setup);
        setup.exec("DROP TRIGGER resources_identity_immutable");
        setup.prepare("UPDATE resources SET resource_key = ? WHERE resource_key = ?")
          .run("tail:Beta", "platform:tail-beta");
        setup.prepare("UPDATE resources SET resource_key = ? WHERE resource_key = ?")
          .run("tail:ALPHA", "platform:tail-alpha-upper");
        setup.prepare("UPDATE resources SET resource_key = ? WHERE resource_key = ?")
          .run("tail:alpha", "platform:tail-alpha");
      } finally {
        setup.close();
      }
      const resources = (await app.inject({ method: "GET",
        url: "/api/resources?q=tail&pageSize=20" })).json().items as Array<{
          resource: { id: number; resourceKey: string };
        }>;
      const expectedResourceIds = ["tail:ALPHA", "tail:alpha", "tail:Beta"]
        .map((key) => resources.find((item) => item.resource.resourceKey === key)!
          .resource.id);
      for (const direction of ["asc", "desc"] as const) {
        const response = await app.inject({ method: "GET",
          url: `/api/resources?q=tail&priority_mode=my&sort_by=name&sort_direction=${direction}&pageSize=20` });
        expect(response.statusCode).toBe(200);
        expect(response.json().items.map((item: {
          resource: { id: number };
        }) => item.resource.id)).toEqual(expectedResourceIds);
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when personalization is unavailable and returns typed search conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-list-off-"));
    const off = createApp({
      databasePath: join(directory, "off.sqlite"),
      logger: false,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        context: true,
        resources: true,
        priorityReaders: true,
        priorityPersonalization: false,
      },
      localDevProxySecret: "priority-off-secret",
    });
    const on = createApp({
      databasePath: join(directory, "on.sqlite"),
      logger: false,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        context: true,
        resources: true,
        priorityPersonalization: true,
        priorityReaders: true,
      },
      localDevProxySecret: "priority-on-secret",
    });
    try {
      const bootstrap = async (app: ReturnType<typeof createApp>, secret: string) => {
        const response = await app.inject({ method: "POST",
          url: "/api/local/session/bootstrap",
          headers: { "x-tabhub-dev-proxy-secret": secret } });
        expect(response.statusCode).toBe(204);
        return String(response.headers["set-cookie"]).split(";", 1)[0]!;
      };
      const offCookie = await bootstrap(off, "priority-off-secret");
      const onCookie = await bootstrap(on, "priority-on-secret");
      const offBefore = databaseSnapshot(join(directory, "off.sqlite"));
      const onBefore = databaseSnapshot(join(directory, "on.sqlite"));

      for (const row of [
        { url: "/api/tabs?priority_mode=ai" },
        { url: "/api/tabs?needs_review=true" },
        { url: "/api/local/tabs?priority_mode=ai", cookie: offCookie },
        { url: "/api/local/tabs?needs_review=false", cookie: offCookie },
        { url: "/api/resources?priority_mode=recommended" },
        { url: "/api/resources?needs_review=true" },
      ]) {
        const disabled = await off.inject({ method: "GET", url: row.url,
          ...(row.cookie === undefined ? {} : { headers: {
            cookie: row.cookie, "sec-fetch-site": "same-origin",
          } }) });
        expect(disabled.statusCode, row.url).toBe(409);
        expect(disabled.json(), row.url).toEqual({
          error: "FEATURE_DISABLED", feature: "priorityPersonalization",
        });
      }
      expect((await off.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ priorityPersonalization: false });

      for (const endpoint of ["/api/tabs", "/api/local/tabs"] as const) {
        for (const relevance of ["search_mode=semantic&q=test", "similar_to=1"] as const) {
          for (const personalization of ["priority_mode=recommended",
            "needs_review=true"] as const) {
            const url = `${endpoint}?${personalization}&${relevance}`;
            const conflict = await on.inject({ method: "GET", url,
              ...(endpoint === "/api/local/tabs" ? { headers: {
                cookie: onCookie, "sec-fetch-site": "same-origin",
              } } : {}) });
            expect(conflict.statusCode, url).toBe(409);
            expect(conflict.json(), url).toEqual({
          error: "PRIORITY_SEARCH_MODE_CONFLICT",
          message: "Priority mode cannot be combined with relevance pagination",
        });
          }
        }
      }
      expect(databaseSnapshot(join(directory, "off.sqlite"))).toBe(offBefore);
      expect(databaseSnapshot(join(directory, "on.sqlite"))).toBe(onBefore);
    } finally {
      await off.close();
      await on.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies AI, Recommended and needs-review truth tables before duplicate pagination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-matrix-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({
      databasePath,
      logger: false,
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        context: true,
        logicalImportance: true,
        priorityPersonalization: true,
        priorityReaders: true,
      },
      localDevProxySecret: "priority-matrix-secret",
    });
    try {
      const rows = ["critical", "user-high", "ai-high", "user-low", "missing"];
      for (const [browser, suffix] of [["chrome", "c"], ["edge", "e"]] as const) {
        const selected = browser === "edge" ? ["user-high"] : rows;
        await app.inject({ method: "POST", url: "/api/ingest/snapshot", payload: {
          browser,
          installationId: `${suffix.repeat(8)}-1111-4111-8111-${suffix.repeat(12)}`,
          browserSessionId: `${suffix.repeat(8)}-2222-4222-8222-${suffix.repeat(12)}`,
          tabs: selected.map((slug, index) => ({
            tabId: index + 1,
            url: `https://${slug}.test/`, title: slug, windowId: 1, index,
          })),
        } });
      }
      const listed = (await app.inject({ method: "GET", url: "/api/tabs?pageSize=20" }))
        .json().items as Array<{
          id: number; logicalPageId: number; title: string; browser: string;
        }>;
      const logicalByTitle = new Map(listed.map((item) => [item.title, item.logicalPageId]));
      const tabByTitle = new Map(listed.map((item) => [item.title, item.id]));
      for (const [title, importance] of [["user-high", 3], ["user-low", 1]] as const) {
        expect((await app.inject({ method: "PATCH", url: `/api/tabs/${tabByTitle.get(title)}`,
          payload: { importance } })).statusCode).toBe(200);
      }

      const connection = new Database(databasePath);
      try {
        installSchema26Capabilities(connection);
        const catalog = createPriorityFeatureCatalog(connection);
        const fingerprint = (title: string) => catalog.read({ type: "page",
          logicalPageId: logicalByTitle.get(title)! }, at).featureFingerprint;
        insertPageOutcome(connection, { id: 101,
          logicalPageId: logicalByTitle.get("critical")!, score: 90,
          fingerprint: fingerprint("critical") });
        insertPageOutcome(connection, { id: 102,
          logicalPageId: logicalByTitle.get("user-high")!, score: 80,
          needsReview: true, fingerprint: "b".repeat(64) });
        insertPageOutcome(connection, { id: 103,
          logicalPageId: logicalByTitle.get("ai-high")!, score: 70,
          needsReview: true, fingerprint: fingerprint("ai-high") });
        insertPageOutcome(connection, { id: 104,
          logicalPageId: logicalByTitle.get("user-low")!, kind: "exclusion",
          fingerprint: fingerprint("user-low") });
      } finally {
        connection.close();
      }
      const beforePriorityReads = databaseSnapshot(databasePath);

      const items = async (query: string) => (await app.inject({
        method: "GET", url: `/api/tabs?pageSize=20&${query}`,
      })).json().items as Array<{ id: number; title: string; browser: string }>;
      const physicalId = (title: string, browser: string) => listed.find((item) =>
        item.title === title && item.browser === browser)!.id;
      const expectedAiIds = [
        physicalId("critical", "chrome"), physicalId("ai-high", "chrome"),
        physicalId("user-high", "chrome"), physicalId("user-low", "chrome"),
        physicalId("missing", "chrome"), physicalId("user-high", "edge"),
      ];
      const expectedRecommendedIds = [
        physicalId("critical", "chrome"), physicalId("user-high", "chrome"),
        physicalId("user-high", "edge"), physicalId("ai-high", "chrome"),
        physicalId("user-low", "chrome"), physicalId("missing", "chrome"),
      ];
      const expectedReviewIds = [physicalId("ai-high", "chrome")];
      const expectedNotReviewIds = [
        physicalId("critical", "chrome"), physicalId("user-high", "chrome"),
        physicalId("user-low", "chrome"), physicalId("missing", "chrome"),
        physicalId("user-high", "edge"),
      ];
      expect((await items("priority_mode=ai")).map((item) => item.id))
        .toEqual(expectedAiIds);
      expect((await items("priority_mode=recommended")).map((item) => item.id))
        .toEqual(expectedRecommendedIds);
      expect((await items("needs_review=true")).map((item) => item.id))
        .toEqual(expectedReviewIds);
      expect((await items("needs_review=false")).map((item) => item.id))
        .toEqual(expectedNotReviewIds);

      const paged: number[] = [];
      for (let page = 1; page <= Math.ceil(expectedRecommendedIds.length / 2); page += 1) {
        const response = await app.inject({ method: "GET",
          url: `/api/tabs?priority_mode=recommended&page=${page}&pageSize=2` });
        paged.push(...response.json().items.map((item: { id: number }) => item.id));
      }
      expect(paged).toEqual(expectedRecommendedIds);
      expect(new Set(paged).size).toBe(expectedRecommendedIds.length);
      const filteredPage = await app.inject({ method: "GET",
        url: "/api/tabs?priority_mode=recommended&browser=chrome&page=2&pageSize=2" });
      expect(filteredPage.statusCode).toBe(200);
      expect(filteredPage.json().total).toBe(5);
      expect(filteredPage.json().items.map((item: { id: number }) => item.id))
        .toEqual([physicalId("ai-high", "chrome"),
          physicalId("user-low", "chrome")]);

      const bootstrap = await app.inject({ method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "priority-matrix-secret" } });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const local = await app.inject({ method: "GET",
        url: "/api/local/tabs?priority_mode=ai&pageSize=20",
        headers: { cookie, "sec-fetch-site": "same-origin" } });
      expect(local.statusCode).toBe(200);
      expect(local.json().items.map((item: { id: number }) => item.id))
        .toEqual(expectedAiIds);
      for (const url of [
        "/api/local/tabs?needs_review=true&search_mode=semantic&q=test",
        "/api/local/tabs?needs_review=false&similar_to=1",
      ]) {
        expect((await app.inject({ method: "GET", url,
          headers: { cookie, "sec-fetch-site": "same-origin" } })).json())
          .toMatchObject({ error: "PRIORITY_SEARCH_MODE_CONFLICT" });
      }
      expect(databaseSnapshot(databasePath)).toBe(beforePriorityReads);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Resource My/AI/Recommended parity and treats merged outcomes as unranked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-resource-priority-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({
      databasePath,
      logger: false,
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        resources: true,
        priorityPersonalization: true,
        priorityReaders: true,
      },
      localDevProxySecret: "resource-priority-secret",
    });
    try {
      const bootstrap = await app.inject({ method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "resource-priority-secret" } });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const headers = { cookie, "sec-fetch-site": "same-origin" };
      for (const [index, name] of ["A critical", "B user high", "C AI high",
        "D user low", "E missing"].entries()) {
        const created = await app.inject({ method: "POST", url: "/api/resources/commands",
          headers, payload: { kind: "create", resourceKey: `platform:c60a-${index}`,
            name, resourceKind: "platform", accessClass: "public",
            idempotencyKey: `create-${index}` } });
        expect(created.statusCode).toBe(200);
      }
      const resources = (await app.inject({ method: "GET",
        url: "/api/resources?pageSize=50" })).json().items as Array<{
          resource: { id: number; name: string; resourceKey: string }; version: number;
        }>;
      const testResources = resources.filter((item) =>
        item.resource.resourceKey.startsWith("platform:c60a-"));
      const byName = new Map(testResources.map((item) => [item.resource.name, item]));
      for (const [name, evaluation] of [["B user high", 3], ["D user low", 1]] as const) {
        expect((await app.inject({ method: "PUT",
          url: `/api/resources/${byName.get(name)!.resource.id}/user-evaluation`,
          headers, payload: { evaluation, idempotencyKey: `evaluation-${evaluation}` } }))
          .statusCode).toBe(200);
      }
      const connection = new Database(databasePath);
      try {
        installSchema26Capabilities(connection);
        const catalog = createPriorityFeatureCatalog(connection);
        const fingerprint = (name: string) => catalog.read({ type: "resource",
          resourceId: byName.get(name)!.resource.id }, at).featureFingerprint;
        insertResourceOutcome(connection, { id: 201,
          resourceId: byName.get("A critical")!.resource.id, score: 90,
          fingerprint: fingerprint("A critical") });
        insertResourceOutcome(connection, { id: 202,
          resourceId: byName.get("B user high")!.resource.id, score: 80,
          needsReview: true, fingerprint: "c".repeat(64) });
        insertResourceOutcome(connection, { id: 203,
          resourceId: byName.get("C AI high")!.resource.id, score: 70,
          needsReview: true, fingerprint: fingerprint("C AI high") });
        insertResourceOutcome(connection, { id: 204,
          resourceId: byName.get("D user low")!.resource.id, kind: "exclusion",
          fingerprint: fingerprint("D user low") });
      } finally {
        connection.close();
      }
      const beforePriorityReads = databaseSnapshot(databasePath);
      const resourceItems = async (query: string) => (await app.inject({ method: "GET",
        url: `/api/resources?pageSize=50&q=c60a&${query}` })).json().items as Array<{
          resource: { id: number; name: string };
        }>;
      const names = async (query: string) => (await resourceItems(query))
        .map((item) => item.resource.name);
      expect(await names("priority_mode=my")).toEqual([
        "B user high", "D user low", "A critical", "C AI high", "E missing",
      ]);
      expect(await names("priority_mode=ai")).toEqual([
        "A critical", "C AI high", "B user high", "D user low", "E missing",
      ]);
      expect(await names("priority_mode=recommended")).toEqual([
        "A critical", "B user high", "C AI high", "D user low", "E missing",
      ]);
      expect(await names("needs_review=true")).toEqual(["C AI high"]);
      expect(await names("needs_review=false")).toEqual([
        "A critical", "B user high", "D user low", "E missing",
      ]);
      for (const [direction, expected] of [
        ["asc", ["B user high", "D user low", "A critical", "C AI high", "E missing"]],
        ["desc", ["B user high", "D user low", "E missing", "C AI high", "A critical"]],
      ] as const) {
        expect(await names(`priority_mode=my&sort_by=name&sort_direction=${direction}`))
          .toEqual(expected);
      }
      const expectedRecommendedIds = ["A critical", "B user high", "C AI high",
        "D user low", "E missing"].map((name) => byName.get(name)!.resource.id);
      const pagedIds: number[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await app.inject({ method: "GET",
          url: `/api/resources?q=c60a&priority_mode=recommended&page=${page}&pageSize=2` });
        expect(response.statusCode).toBe(200);
        pagedIds.push(...response.json().items.map((item: {
          resource: { id: number };
        }) => item.resource.id));
      }
      expect(pagedIds).toEqual(expectedRecommendedIds);
      expect(new Set(pagedIds).size).toBe(expectedRecommendedIds.length);
      const filteredPage = await app.inject({ method: "GET",
        url: "/api/resources?q=c60a&kind=platform&priority_mode=recommended&page=2&pageSize=2" });
      expect(filteredPage.json().total).toBe(5);
      expect(filteredPage.json().items.map((item: {
        resource: { id: number };
      }) => item.resource.id)).toEqual(expectedRecommendedIds.slice(2, 4));
      expect(databaseSnapshot(databasePath)).toBe(beforePriorityReads);

      const source = byName.get("B user high")!;
      const target = byName.get("E missing")!;
      const merged = await app.inject({ method: "POST", url: "/api/resources/commands",
        headers, payload: { kind: "merge", sourceResourceId: source.resource.id,
          targetResourceId: target.resource.id, expectedSourceVersion: source.version,
          expectedTargetVersion: target.version, expectedRulesetVersion: 1,
          idempotencyKey: "merge-inactive-priority" } });
      expect(merged.statusCode).toBe(200);
      const inactive = await app.inject({ method: "GET",
        url: "/api/resources?lifecycleState=merged&priority_mode=recommended&pageSize=50" });
      expect(inactive.statusCode).toBe(200);
      expect(inactive.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: expect.objectContaining({
          id: source.resource.id, lifecycleState: "merged",
        }), preference: expect.objectContaining({ userEvaluation: 3 }) }),
      ]));
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never sends inactive merged Resource IDs to the priority reader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-inactive-priority-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let sourceId = 0;
    const app = createApp({
      databasePath, logger: false,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        resources: true, priorityReaders: true, priorityPersonalization: true,
      },
      localDevProxySecret: "inactive-priority-secret",
    });
    try {
      const bootstrap = await app.inject({ method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "inactive-priority-secret" } });
      const headers = { cookie: String(bootstrap.headers["set-cookie"])
        .split(";", 1)[0]!, "sec-fetch-site": "same-origin" };
      const created = [];
      for (const [index, name] of ["inactive source", "inactive target"].entries()) {
        const response = await app.inject({ method: "POST",
          url: "/api/resources/commands", headers,
          payload: { kind: "create", resourceKey: `inactive:${index}`, name,
            resourceKind: "platform", accessClass: "public",
            idempotencyKey: `inactive-create-${index}` } });
        expect(response.statusCode).toBe(200);
        created.push(response.json().result.resource);
      }
      expect((await app.inject({ method: "POST", url: "/api/resources/commands",
        headers, payload: { kind: "merge",
          sourceResourceId: created[0].resource.id,
          targetResourceId: created[1].resource.id,
          expectedSourceVersion: created[0].version,
          expectedTargetVersion: created[1].version,
          expectedRulesetVersion: 1,
          idempotencyKey: "inactive-merge" } })).statusCode).toBe(200);
      sourceId = created[0].resource.id;
    } finally {
      await app.close();
    }

    const database = openDatabase(databasePath);
    const calls: number[][] = [];
    try {
      const catalog = createResourceReadCatalog(database.connection, () => ({
        readBatch(subjects) {
          calls.push(subjects.map((subject) => subject.type === "resource"
            ? subject.resourceId : subject.logicalPageId));
          return [];
        },
      }), () => new Date(at));
      const baseQuery = { q: "inactive", lifecycleState: "merged" as const,
        page: 1, pageSize: 50, sort_by: "name" as const,
        sort_direction: "asc" as const };
      expect(catalog.list({ ...baseQuery, priority_mode: "ai" }).items
        .map((item) => item.resource.id)).toEqual([sourceId]);
      expect(catalog.list({ ...baseQuery, needs_review: false }).items
        .map((item) => item.resource.id)).toEqual([sourceId]);
      expect(catalog.list({ ...baseQuery, needs_review: true }).items).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
