import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { openDatabase } from "../src/database.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import { registerResourceRoutes } from "../src/resource-routes.js";

const NOW = "2026-08-14T10:00:00.000Z";

function seedPage(connection: ReturnType<typeof openDatabase>["connection"], url: string) {
  return Number(connection.prepare(`
    INSERT INTO logical_pages (
      identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(url, url, url, NOW, NOW).lastInsertRowid);
}

function seedResource(
  connection: ReturnType<typeof openDatabase>["connection"],
  key: string,
) {
  const resourceId = Number(connection.prepare(`
    INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
  `).run(key, NOW).lastInsertRowid);
  const eventId = Number(connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'website', 'public', 'active', 'user', 'manual', ?)
  `).run(resourceId, key, NOW).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `).run(resourceId, eventId);
  return resourceId;
}

function seedAlias(
  connection: ReturnType<typeof openDatabase>["connection"],
  key: string,
  resourceId: number,
) {
  const ruleId = Number(connection.prepare(`
    INSERT INTO resource_match_rules (
      rule_key, version, resource_id, host_pattern, match_kind,
      path_prefix, priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'shared.example.com', 'exact_host', '/', 10,
      'user_alias', 'user', 'manual', ?)
  `).run(key, resourceId, NOW).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_match_rule_heads (rule_key, rule_id) VALUES (?, ?)
  `).run(key, ruleId);
}

describe("logical-page resource-resolution REST boundary", () => {
  it("returns every closed resolution state without writing or inferring", async () => {
    const database = openDatabase(":memory:");
    const catalog = createResourceCatalog(database.connection, () => new Date(NOW));
    const app = Fastify();
    registerResourceRoutes(app, {
      catalog,
      capabilities: {} as never,
      commands: {} as never,
      context: {} as never,
      reads: {} as never,
      activity: {} as never,
      activityWindows: false,
      priorityPersonalization: false,
    });

    try {
      const resolved = seedPage(database.connection, "https://www.example.com/article");
      const unmatched = seedPage(database.connection, "https://accounts.example.net/login");
      const ambiguous = seedPage(database.connection, "https://shared.example.com/team");
      const excluded = seedPage(database.connection, "chrome://settings/");
      const alpha = seedResource(database.connection, "custom:resolution-alpha");
      const beta = seedResource(database.connection, "custom:resolution-beta");
      seedAlias(database.connection, "alias:resolution-alpha", alpha);
      seedAlias(database.connection, "alias:resolution-beta", beta);
      catalog.backfill();

      const cases = [
        [resolved, "resolved"],
        [unmatched, "unmatched"],
        [ambiguous, "ambiguous"],
        [excluded, "excluded"],
      ] as const;
      for (const [logicalPageId, state] of cases) {
        const before = database.connection.prepare("SELECT total_changes()").pluck().get();
        const response = await app.inject({
          method: "GET",
          url: `/api/logical-pages/${logicalPageId}/resource-resolution`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual(catalog.getResolution(logicalPageId));
        expect(response.json()).toMatchObject({ logicalPageId, state });
        expect(database.connection.prepare("SELECT total_changes()").pluck().get()).toBe(before);
      }

      const beforeMissing = database.connection.prepare("SELECT total_changes()").pluck().get();
      expect((await app.inject({
        method: "GET",
        url: "/api/logical-pages/999999/resource-resolution",
      })).statusCode).toBe(404);
      expect(database.connection.prepare("SELECT total_changes()").pluck().get())
        .toBe(beforeMissing);
    } finally {
      await app.close();
      database.close();
    }
  });
});
