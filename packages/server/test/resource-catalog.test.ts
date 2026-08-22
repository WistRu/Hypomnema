import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createApp } from "../src/app.js";
import { createResourceCatalog } from "../src/resource-catalog.js";

const NOW = "2026-08-12T12:00:00.000Z";

function seedPage(connection: Database.Database, url: string): number {
  return Number(
    connection
      .prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(url, url, url, NOW, NOW).lastInsertRowid,
  );
}

function seedResource(
  connection: Database.Database,
  key: string,
  name: string,
): number {
  const resourceId = Number(
    connection
      .prepare(`INSERT INTO resources (resource_key, created_at) VALUES (?, ?)`)
      .run(key, NOW).lastInsertRowid,
  );
  const eventId = Number(
    connection
      .prepare(`
        INSERT INTO resource_events (
          resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (?, 1, ?, 'website', 'public', 'active', 'user', 'manual', ?)
      `)
      .run(resourceId, name, NOW).lastInsertRowid,
  );
  connection
    .prepare(`INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)`)
    .run(resourceId, eventId);
  return resourceId;
}

function seedAliasRule(
  connection: Database.Database,
  input: {
    key: string;
    resourceId: number;
    host: string;
    path?: string;
    priority?: number;
    provenance?: "user_alias" | "agent_alias" | "system_seed";
    matchKind?: "exact_host" | "suffix_host";
  },
): number {
  const provenance = input.provenance ?? "user_alias";
  const createdBy =
    provenance === "user_alias"
      ? "user"
      : provenance === "agent_alias"
        ? "agent"
        : "system";
  const creationMethod =
    provenance === "user_alias"
      ? "manual"
      : provenance === "agent_alias"
        ? "on_behalf_of_user"
        : "derived";
  const ruleId = Number(
    connection
      .prepare(`
        INSERT INTO resource_match_rules (
          rule_key, version, resource_id, host_pattern, match_kind,
          path_prefix, priority, provenance_class, created_by, creation_method,
          created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.key,
        input.resourceId,
        input.host,
        input.matchKind ?? "suffix_host",
        input.path ?? "/",
        input.priority ?? 0,
        provenance,
        createdBy,
        creationMethod,
        NOW,
      ).lastInsertRowid,
  );
  connection
    .prepare(
      `INSERT INTO resource_match_rule_heads (rule_key, rule_id) VALUES (?, ?)`,
    )
    .run(input.key, ruleId);
  return ruleId;
}

describe("ResourceCatalog", () => {
  it("groups registrable domains and YouTube aliases without creating www resources", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageIds = [
        "https://www.youtube.com/watch?v=one",
        "https://youtu.be/one",
        "https://www.example.co.uk/a",
        "https://m.example.co.uk/b",
        "https://fr.example.co.uk/c",
      ].map((url) => seedPage(database.connection, url));

      expect(catalog.backfill()).toMatchObject({
        processed: 5,
        resolved: 5,
        unmatched: 0,
        ambiguous: 0,
        excluded: 0,
      });

      const resolutions = pageIds.map((id) => catalog.getResolution(id));
      expect(resolutions[0]).toMatchObject({
        state: "resolved",
        reason: "system_seed",
        researchEligible: true,
        sourceFingerprint: expect.stringContaining(
          "psl=tldts-7.4.10;allowPrivateDomains=true",
        ),
      });
      expect(resolutions[1]?.resource?.id).toBe(resolutions[0]?.resource?.id);
      expect(resolutions[2]).toMatchObject({
        state: "resolved",
        reason: "registrable_domain",
        resource: { resourceKey: "domain:example.co.uk" },
      });
      expect(resolutions[3]?.resource?.id).toBe(resolutions[2]?.resource?.id);
      expect(resolutions[4]?.resource?.id).toBe(resolutions[2]?.resource?.id);
      expect(
        database.connection
          .prepare("SELECT resource_key FROM resources ORDER BY resource_key")
          .pluck()
          .all(),
      ).toEqual(["domain:example.co.uk", "platform:youtube"]);
    } finally {
      database.close();
    }
  });

  it("records typed exclusions and refuses URL-only sensitive guesses", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const cases = [
        ["chrome://settings/", "browser_internal"],
        ["chrome-extension://abcdefghijklmnop/options.html", "extension"],
        ["file:///C:/secret.txt", "file"],
        ["data:text/plain,secret", "data"],
        ["blob:https://example.com/opaque", "unsupported_scheme"],
        ["http://localhost:3000/admin", "localhost"],
        ["http://192.168.1.2/private", "private_ip"],
        ["http://router.local/private", "private_hostname"],
        ["https://user:secret@example.com/private", "embedded_credentials"],
        ["https://accounts.example.net/login", "weak_sensitive_signal"],
      ] as const;
      const ids = cases.map(([url]) => seedPage(database.connection, url));

      const result = catalog.backfill();
      expect(result).toMatchObject({ processed: cases.length, excluded: 9, unmatched: 1 });
      cases.forEach(([, reason], index) => {
        expect(catalog.getResolution(ids[index]!)).toMatchObject({
          reason,
          researchEligible: false,
          state: reason === "weak_sensitive_signal" ? "unmatched" : "excluded",
        });
      });
      expect(catalog.list({
        resolution: "unmatched_or_ambiguous",
        page: 1,
        pageSize: 20,
      })).toMatchObject({
        total: 1,
        items: [{
          logicalPageId: ids.at(-1),
          state: "unmatched",
          currentAssignmentId: null,
        }],
      });
      expect(database.connection.prepare("SELECT COUNT(*) FROM resources").pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("returns ambiguous authoritative ties instead of using row IDs", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageId = seedPage(database.connection, "https://docs.example.com/team/guide");
      const alpha = seedResource(database.connection, "custom:alpha", "Alpha");
      const beta = seedResource(database.connection, "custom:beta", "Beta");
      seedAliasRule(database.connection, {
        key: "alias:alpha",
        resourceId: alpha,
        host: "docs.example.com",
        path: "/team",
        priority: 7,
      });
      seedAliasRule(database.connection, {
        key: "alias:beta",
        resourceId: beta,
        host: "docs.example.com",
        path: "/team",
        priority: 7,
      });

      expect(catalog.resolvePage(pageId)).toMatchObject({
        state: "ambiguous",
        reason: "authoritative_tie",
        candidateResourceIds: [alpha, beta],
        resource: null,
      });
      expect(
        catalog.list({ resolution: "unmatched_or_ambiguous", page: 1, pageSize: 20 }),
      ).toMatchObject({ total: 1, items: [{ logicalPageId: pageId, state: "ambiguous" }] });
    } finally {
      database.close();
    }
  });

  it("keeps a manual assignment through repeated backfill", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageId = seedPage(database.connection, "https://www.example.org/article");
      const resourceId = seedResource(database.connection, "custom:manual", "Manual");
      const assignmentId = Number(
        database.connection
          .prepare(`
            INSERT INTO logical_page_resource_assignments (
              logical_page_id, action, resource_id, provenance_class,
              assigned_by, assignment_method, source_fingerprint, created_at
            ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
          `)
          .run(pageId, resourceId, "manual-fixture", NOW).lastInsertRowid,
      );
      database.connection
        .prepare(`
          INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
          VALUES (?, ?)
        `)
        .run(pageId, assignmentId);

      expect(catalog.backfill()).toMatchObject({ processed: 1, resolved: 1 });
      expect(catalog.backfill()).toMatchObject({ processed: 1, unchanged: 1 });
      expect(catalog.getResolution(pageId)).toMatchObject({
        state: "resolved",
        reason: "user_manual",
        resource: { id: resourceId },
      });
      expect(
        database.connection
          .prepare(
            "SELECT assignment_id FROM logical_page_resource_heads WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
      ).toBe(assignmentId);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM logical_page_resource_assignments")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("persists heads and historical resolution semantics across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-resources-restart-"));
    const databasePath = join(directory, "tabhub.sqlite");
    try {
      const first = openDatabase(databasePath);
      const pageId = seedPage(first.connection, "https://news.example.com/story");
      const firstCatalog = createResourceCatalog(first.connection, () => new Date(NOW));
      firstCatalog.backfill();
      const before = firstCatalog.getResolution(pageId);
      const eventCount = first.connection
        .prepare("SELECT COUNT(*) FROM resource_resolution_events")
        .pluck()
        .get();
      first.close();

      const restarted = openDatabase(databasePath);
      try {
        const restartedCatalog = createResourceCatalog(
          restarted.connection,
          () => new Date("2026-08-12T13:00:00.000Z"),
        );
        expect(restartedCatalog.getResolution(pageId)).toEqual(before);
        expect(restartedCatalog.backfill()).toMatchObject({ unchanged: 1 });
        expect(
          restarted.connection
            .prepare("SELECT COUNT(*) FROM resource_resolution_events")
            .pluck()
            .get(),
        ).toBe(eventCount);
      } finally {
        restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses private PSL domains and semantic rule precedence deterministically", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const alice = seedPage(database.connection, "https://alice.github.io/docs");
      const bob = seedPage(database.connection, "https://bob.github.io/docs");
      const youtube = seedPage(
        database.connection,
        "https://www.youtube.com/special/guide",
      );
      const custom = seedResource(database.connection, "custom:video-notes", "Video notes");
      seedAliasRule(database.connection, {
        key: "alias:video-notes",
        resourceId: custom,
        host: "youtube.com",
        path: "/special",
        priority: -100,
        provenance: "user_alias",
      });

      catalog.backfill();
      expect(catalog.getResolution(alice)).toMatchObject({
        resource: { resourceKey: "domain:alice.github.io" },
      });
      expect(catalog.getResolution(bob)).toMatchObject({
        resource: { resourceKey: "domain:bob.github.io" },
      });
      expect(catalog.getResolution(youtube)).toMatchObject({
        reason: "explicit_alias",
        resource: { id: custom },
      });
      const persistedState = database.connection
        .prepare(`
          SELECT events.state
          FROM resource_resolution_heads AS heads
          JOIN resource_resolution_events AS events
            ON events.id = heads.resolution_event_id
          WHERE heads.logical_page_id = ?
        `)
        .pluck()
        .get(youtube);
      expect(persistedState).toBe("matched");
    } finally {
      database.close();
    }
  });

  it("normalizes case, trailing dots, ports, and IDN hosts before grouping", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const variants = [
        "https://WWW.Example.Co.Uk.:8443/one",
        "https://m.example.co.uk/two",
        "https://fr.example.co.uk/three",
      ].map((url) => seedPage(database.connection, url));
      const unicode = seedPage(database.connection, "https://BÜCHER.de:443/read");

      catalog.backfill();
      const baseResourceId = catalog.getResolution(variants[0]!)?.resource?.id;
      expect(baseResourceId).toBeTypeOf("number");
      expect(catalog.getResolution(variants[1]!)?.resource?.id).toBe(baseResourceId);
      expect(catalog.getResolution(variants[2]!)?.resource?.id).toBe(baseResourceId);
      expect(catalog.getResolution(unicode)).toMatchObject({
        resource: { resourceKey: "domain:xn--bcher-kva.de" },
      });
    } finally {
      database.close();
    }
  });

  it("classifies loopback/private IPv4 and IPv6 without excluding public IPs", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const privateIds = [
        "http://127.0.0.1/",
        "http://10.2.3.4/",
        "http://172.16.9.1/",
        "http://192.168.1.4/",
        "http://[::1]/",
        "http://[fd00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:192.168.1.4]/",
      ].map((url) => seedPage(database.connection, url));
      const publicIds = [
        "https://8.8.8.8/",
        "https://[2606:4700:4700::1111]/",
      ].map((url) => seedPage(database.connection, url));

      catalog.backfill();
      for (const logicalPageId of privateIds) {
        expect(catalog.getResolution(logicalPageId)).toMatchObject({
          state: "excluded",
          reason: "private_ip",
          researchEligible: false,
        });
      }
      for (const logicalPageId of publicIds) {
        expect(catalog.getResolution(logicalPageId)).toMatchObject({
          state: "unmatched",
          reason: "registrable_domain_unavailable",
          researchEligible: false,
        });
      }
    } finally {
      database.close();
    }
  });

  it("leaves unknown suffixes unmatched but permits an explicit public-IP rule", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const unknownIds = [
        "https://foo.lan/page",
        "https://domain.unknown/page",
        "https://corp.internal/page",
      ].map((url) => seedPage(database.connection, url));
      const publicIp = seedPage(database.connection, "https://8.8.8.8/docs");
      const dnsResource = seedResource(database.connection, "custom:public-dns", "Public DNS");
      seedAliasRule(database.connection, {
        key: "alias:public-dns",
        resourceId: dnsResource,
        host: "8.8.8.8",
        matchKind: "exact_host",
      });

      catalog.backfill();
      for (const logicalPageId of unknownIds) {
        expect(catalog.getResolution(logicalPageId)).toMatchObject({
          state: "unmatched",
          reason: "registrable_domain_unavailable",
          researchEligible: false,
          researchExclusionReason: "registrable_domain_unavailable",
        });
      }
      expect(catalog.getResolution(publicIp)).toMatchObject({
        state: "resolved",
        reason: "explicit_alias",
        resource: { id: dnsResource },
        researchEligible: true,
        researchExclusionReason: null,
      });
    } finally {
      database.close();
    }
  });

  it("matches path prefixes on segment boundaries", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const exact = seedPage(database.connection, "https://docs.acme.com/foo");
      const child = seedPage(database.connection, "https://docs.acme.com/foo/child");
      const sibling = seedPage(database.connection, "https://docs.acme.com/foobar");
      const resourceId = seedResource(database.connection, "custom:foo", "Foo docs");
      seedAliasRule(database.connection, {
        key: "alias:foo",
        resourceId,
        host: "docs.acme.com",
        path: "/foo",
      });

      catalog.backfill();
      expect(catalog.getResolution(exact)).toMatchObject({ resource: { id: resourceId } });
      expect(catalog.getResolution(child)).toMatchObject({ resource: { id: resourceId } });
      expect(catalog.getResolution(sibling)).not.toMatchObject({
        resource: { id: resourceId },
      });
    } finally {
      database.close();
    }
  });

  it("preserves manual grouping for private pages but keeps a typed research exclusion", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageId = seedPage(database.connection, "http://192.168.1.7/internal");
      const resourceId = seedResource(database.connection, "custom:intranet", "Intranet");
      const assignmentId = Number(
        database.connection
          .prepare(`
            INSERT INTO logical_page_resource_assignments (
              logical_page_id, action, resource_id, provenance_class,
              assigned_by, assignment_method, source_fingerprint, created_at
            ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
          `)
          .run(pageId, resourceId, "manual-intranet", NOW).lastInsertRowid,
      );
      database.connection
        .prepare(`
          INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
          VALUES (?, ?)
        `)
        .run(pageId, assignmentId);

      expect(catalog.resolvePage(pageId)).toMatchObject({
        state: "resolved",
        reason: "user_manual",
        resource: { id: resourceId },
        researchEligible: false,
        researchExclusionReason: "private_ip",
      });
      expect(
        database.connection
          .prepare(`
            SELECT state, research_exclusion_reason
            FROM resource_resolution_events
            WHERE logical_page_id = ?
          `)
          .get(pageId),
      ).toEqual({ state: "overridden", research_exclusion_reason: "private_ip" });
    } finally {
      database.close();
    }
  });

  it("hooks new-page resolution atomically only when the resources feature is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-resource-hook-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const featuresOff = {
      context: false,
      logicalImportance: false,
      priorityShadow: false,
      research: false,
      resources: false,
    } as const;
    const featuresOn = { ...featuresOff, resources: true } as const;
    try {
      const offApp = createApp({ databasePath, featureFlags: featuresOff, logger: false });
      const offResponse = await offApp.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [{ url: "https://feature-off.test/page", windowId: 1, index: 0 }],
        },
      });
      expect(offResponse.statusCode).toBe(200);
      await offApp.close();

      let inspection = new Database(databasePath, { fileMustExist: true });
      expect(
        inspection.prepare("SELECT COUNT(*) FROM resource_resolution_events").pluck().get(),
      ).toBe(0);
      inspection.close();

      const onApp = createApp({ databasePath, featureFlags: featuresOn, logger: false });
      // Construction performs the feature-gated initial backfill.
      inspection = new Database(databasePath, { fileMustExist: true });
      expect(
        inspection.prepare("SELECT COUNT(*) FROM resource_resolution_events").pluck().get(),
      ).toBe(1);
      inspection.exec(`
        CREATE TRIGGER reject_resource_hook
        BEFORE INSERT ON resource_resolution_events
        WHEN (
          SELECT url_normalized FROM logical_pages WHERE id = NEW.logical_page_id
        ) = 'https://rollback.test/page'
        BEGIN
          SELECT RAISE(ABORT, 'forced resolver failure');
        END;
      `);
      inspection.close();

      const newPage = await onApp.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [{ url: "https://new-page.test/page", windowId: 2, index: 0 }],
        },
      });
      expect(newPage.statusCode).toBe(200);
      const failedPage = await onApp.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "yandex",
          tabs: [{ url: "https://rollback.test/page", windowId: 3, index: 0 }],
        },
      });
      expect(failedPage.statusCode).toBe(500);

      inspection = new Database(databasePath, { fileMustExist: true });
      expect(
        inspection
          .prepare(`
            SELECT COUNT(*)
            FROM resource_resolution_heads AS heads
            JOIN logical_pages ON logical_pages.id = heads.logical_page_id
            WHERE logical_pages.identity_key = 'https://new-page.test/page'
          `)
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) FROM logical_pages WHERE identity_key = 'https://rollback.test/page'",
          )
          .pluck()
          .get(),
      ).toBe(0);
      inspection.close();
      await onApp.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back event and assignment head changes when resolution head swap fails", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageId = seedPage(database.connection, "https://docs.rollback.com/team/page");
      catalog.resolvePage(pageId);
      const before = {
        assignments: database.connection
          .prepare("SELECT COUNT(*) FROM logical_page_resource_assignments")
          .pluck()
          .get(),
        resolutions: database.connection
          .prepare("SELECT COUNT(*) FROM resource_resolution_events")
          .pluck()
          .get(),
        assignmentHead: database.connection
          .prepare(
            "SELECT assignment_id FROM logical_page_resource_heads WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
        resolutionHead: database.connection
          .prepare(
            "SELECT resolution_event_id FROM resource_resolution_heads WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
      };
      const custom = seedResource(database.connection, "custom:rollback", "Rollback");
      seedAliasRule(database.connection, {
        key: "alias:rollback",
        resourceId: custom,
        host: "docs.rollback.com",
        path: "/team",
      });
      database.connection.exec(`
        CREATE TRIGGER reject_resolution_head_swap
        BEFORE UPDATE ON resource_resolution_heads
        WHEN NEW.logical_page_id = ${pageId}
        BEGIN
          SELECT RAISE(ABORT, 'forced head swap failure');
        END;
      `);

      expect(() => catalog.resolvePage(pageId)).toThrow(/forced head swap failure/);
      expect({
        assignments: database.connection
          .prepare("SELECT COUNT(*) FROM logical_page_resource_assignments")
          .pluck()
          .get(),
        resolutions: database.connection
          .prepare("SELECT COUNT(*) FROM resource_resolution_events")
          .pluck()
          .get(),
        assignmentHead: database.connection
          .prepare(
            "SELECT assignment_id FROM logical_page_resource_heads WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
        resolutionHead: database.connection
          .prepare(
            "SELECT resolution_event_id FROM resource_resolution_heads WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
      }).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("allows privacy deletion of a logical page while guarding direct history deletion", () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    try {
      const pageId = seedPage(database.connection, "https://privacy-delete.com/page");
      catalog.resolvePage(pageId);
      expect(() =>
        database.connection
          .prepare(
            "DELETE FROM resource_resolution_events WHERE logical_page_id = ?",
          )
          .run(pageId),
      ).toThrow(/append-only/);

      database.connection.prepare("DELETE FROM logical_pages WHERE id = ?").run(pageId);
      expect(
        database.connection
          .prepare(
            "SELECT COUNT(*) FROM resource_resolution_events WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
      ).toBe(0);
      expect(
        database.connection
          .prepare(
            "SELECT COUNT(*) FROM logical_page_resource_assignments WHERE logical_page_id = ?",
          )
          .pluck()
          .get(pageId),
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});
