import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createResourceCatalog } from "../src/resource-catalog.js";

const NOW = "2026-08-14T12:00:00.000Z";

function seedResource(
  connection: Database.Database,
  key: string,
  name: string,
): number {
  const resourceId = Number(connection.prepare(`
    INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
  `).run(key, NOW).lastInsertRowid);
  const eventId = Number(connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'website', 'public', 'active', 'user', 'manual', ?)
  `).run(resourceId, name, NOW).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `).run(resourceId, eventId);
  return resourceId;
}

function seedRule(
  connection: Database.Database,
  input: {
    key: string;
    resourceId: number;
    host: string;
    matchKind?: "exact_host" | "suffix_host";
    path?: string;
    priority?: number;
  },
): void {
  const ruleId = Number(connection.prepare(`
    INSERT INTO resource_match_rules (
      rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, 'user_alias', 'user', 'manual', ?)
  `).run(
    input.key,
    input.resourceId,
    input.host,
    input.matchKind ?? "suffix_host",
    input.path ?? "/",
    input.priority ?? 0,
    NOW,
  ).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_match_rule_heads (rule_key, rule_id) VALUES (?, ?)
  `).run(input.key, ruleId);
}

describe("Resource URL preview", () => {
  it("resolves an unpersisted suffix-host URL without writing resolver history", () => {
    const database = openDatabase(":memory:");
    try {
      const catalog = createResourceCatalog(database.connection);
      const before = database.connection.prepare(`
        SELECT
          (SELECT count(*) FROM resources) AS resources,
          (SELECT count(*) FROM logical_page_resource_assignments) AS assignments,
          (SELECT count(*) FROM resource_resolution_events) AS resolutions
      `).get();

      const preview = catalog.previewResourceUrl(
        "https://www.youtube.com/watch?v=preview",
        1,
      );

      expect(preview).toMatchObject({
        kind: "accepted",
        rulesetVersion: 1,
        resource: { resourceKey: "platform:youtube" },
      });
      expect(preview.rulesetResourceGenerationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(database.connection.prepare(`
        SELECT
          (SELECT count(*) FROM resources) AS resources,
          (SELECT count(*) FROM logical_page_resource_assignments) AS assignments,
          (SELECT count(*) FROM resource_resolution_events) AS resolutions
      `).get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("uses the resolver's exact-host, path-prefix, and priority precedence", () => {
    const database = openDatabase(":memory:");
    try {
      const exact = seedResource(database.connection, "custom:exact", "Exact");
      const suffix = seedResource(database.connection, "custom:suffix", "Suffix");
      seedRule(database.connection, {
        key: "preview:suffix", resourceId: suffix, host: "example.com",
      });
      seedRule(database.connection, {
        key: "preview:exact", resourceId: exact, host: "docs.example.com",
        matchKind: "exact_host",
      });

      const root = seedResource(database.connection, "custom:root", "Root");
      const path = seedResource(database.connection, "custom:path", "Path");
      seedRule(database.connection, {
        key: "preview:root", resourceId: root, host: "path.example.com",
      });
      seedRule(database.connection, {
        key: "preview:path", resourceId: path, host: "path.example.com", path: "/team",
      });

      const longPath = seedResource(database.connection, "custom:long-path", "Long path");
      const priority = seedResource(database.connection, "custom:priority", "Priority");
      seedRule(database.connection, {
        key: "preview:long-path", resourceId: longPath, host: "priority.example.net",
        path: "/team/guide",
      });
      seedRule(database.connection, {
        key: "preview:priority", resourceId: priority, host: "priority.example.net", priority: 1,
      });

      const catalog = createResourceCatalog(database.connection);
      expect(catalog.previewResourceUrl("https://docs.example.com/", 1)).toMatchObject({
        kind: "accepted", resource: { id: exact },
      });
      expect(catalog.previewResourceUrl("https://sub.path.example.com/team/guide", 1)).toMatchObject({
        kind: "accepted", resource: { id: path },
      });
      expect(catalog.previewResourceUrl("https://priority.example.net/team/guide", 1)).toMatchObject({
        kind: "accepted", resource: { id: priority },
      });
    } finally {
      database.close();
    }
  });

  it("returns closed ambiguous, unmatched, and unsupported outcomes", () => {
    const database = openDatabase(":memory:");
    try {
      const alpha = seedResource(database.connection, "custom:alpha", "Alpha");
      const beta = seedResource(database.connection, "custom:beta", "Beta");
      seedRule(database.connection, {
        key: "preview:alpha", resourceId: alpha, host: "tie.example.org", path: "/team",
        priority: 7,
      });
      seedRule(database.connection, {
        key: "preview:beta", resourceId: beta, host: "tie.example.org", path: "/team",
        priority: 7,
      });
      const catalog = createResourceCatalog(database.connection);

      expect(catalog.previewResourceUrl("https://tie.example.org/team/guide", 1)).toMatchObject({
        kind: "ambiguous",
        candidateResourceIds: [alpha, beta],
        matchedRuleKeys: ["preview:alpha@1", "preview:beta@1"],
      });
      expect(catalog.previewResourceUrl("https://unmatched.example/", 1)).toMatchObject({
        kind: "unmatched",
      });
      expect(catalog.previewResourceUrl("https://unmatched.example/", 2)).toMatchObject({
        kind: "unsupported", reason: "ruleset_version_mismatch",
      });
      expect(catalog.previewResourceUrl("http://127.0.0.1/private", 1)).toMatchObject({
        kind: "unsupported", reason: "private_ip",
      });
      for (const outcome of [
        catalog.previewResourceUrl("https://tie.example.org/team/guide", 1),
        catalog.previewResourceUrl("https://unmatched.example/", 1),
        catalog.previewResourceUrl("http://127.0.0.1/private", 1),
      ]) {
        expect(outcome.rulesetResourceGenerationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      database.close();
    }
  });
});
