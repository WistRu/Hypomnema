import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { ResourceCatalogCommand } from "@tabhub/shared";

import {
  createResourceCommandCatalog,
  type ResourceCommandCatalogTestHooks,
} from "../src/resource-command-catalog.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import { openDatabase } from "../src/database.js";

const NOW = "2026-08-12T12:00:00.000Z";
const USER_PROVENANCE = { actor: "user", method: "manual" } as const;
const AGENT_PROVENANCE = {
  actor: "agent",
  method: "on_behalf_of_user",
} as const;

function commands(
  connection: Database.Database,
  hooks: ResourceCommandCatalogTestHooks = {},
) {
  return createResourceCommandCatalog(
    connection,
    () => new Date(NOW),
    hooks,
  );
}

function createResource(
  connection: Database.Database,
  input: { key: string; name: string; idempotencyKey: string },
): { id: number; version: number } {
  const receipt = commands(connection).change({
    kind: "create",
    resourceKey: input.key,
    name: input.name,
    resourceKind: "platform",
    accessClass: "public",
    provenance: USER_PROVENANCE,
    idempotencyKey: input.idempotencyKey,
  });
  if (receipt.result.kind !== "create") throw new Error("unexpected receipt");
  return {
    id: receipt.result.resource.resource.id,
    version: receipt.result.resource.version,
  };
}

function currentRulesetVersion(connection: Database.Database): number {
  return connection
    .prepare(`
      SELECT events.version
      FROM resource_ruleset_heads AS heads
      JOIN resource_ruleset_events AS events
        ON events.id = heads.ruleset_event_id
      WHERE heads.scope = 'global'
    `)
    .pluck()
    .get() as number;
}

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

function currentAssignmentId(
  connection: Database.Database,
  logicalPageId: number,
): number | null {
  return (connection
    .prepare(`
      SELECT assignments.id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
      WHERE heads.logical_page_id = ?
    `)
    .pluck()
    .get(logicalPageId) as number | undefined) ?? null;
}

function currentMembershipResource(
  connection: Database.Database,
  logicalPageId: number,
): number | null {
  return (connection
    .prepare(`
      SELECT assignments.resource_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
      WHERE heads.logical_page_id = ? AND assignments.action = 'assigned'
    `)
    .pluck()
    .get(logicalPageId) as number | undefined) ?? null;
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe("ResourceCommandCatalog create", () => {
  it("creates normalized identity/event/head/preference and exact replay receipt", () => {
    const database = openDatabase(":memory:");
    try {
      const catalog = commands(database.connection);
      const input = {
        kind: "create",
        resourceKey: "  PLATFORM:GitHub  ",
        name: "  GitHub  ",
        resourceKind: "platform",
        accessClass: "public",
        provenance: USER_PROVENANCE,
        idempotencyKey: "create-github",
      } as const;
      const receipt = catalog.change(input);
      const normalizedReplay = catalog.change({
        ...input,
        resourceKey: "platform:github",
        name: "GitHub",
      });

      expect(normalizedReplay).toEqual(receipt);
      expect(receipt).toMatchObject({
        idempotencyKey: "create-github",
        commandKind: "create",
        createdAt: NOW,
        result: {
          kind: "create",
          changed: true,
          resource: {
            version: 1,
            resource: {
              resourceKey: "platform:github",
              name: "GitHub",
              kind: "platform",
              accessClass: "public",
              lifecycleState: "active",
            },
          },
        },
      });
      const resourceId =
        receipt.result.kind === "create"
          ? receipt.result.resource.resource.id
          : 0;
      expect(
        database.connection
          .prepare(`
            SELECT created_by, creation_method, lifecycle_state,
              merged_into_resource_id
            FROM resource_events WHERE resource_id = ?
          `)
          .get(resourceId),
      ).toEqual({
        created_by: "user",
        creation_method: "manual",
        lifecycle_state: "active",
        merged_into_resource_id: null,
      });
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_preferences WHERE resource_id = ?")
          .pluck()
          .get(resourceId),
      ).toBe(1);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_command_receipts")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("returns typed conflicts for same-key semantic drift and duplicate keys", () => {
    const database = openDatabase(":memory:");
    try {
      const catalog = commands(database.connection);
      const base = {
        kind: "create",
        resourceKey: "platform:github",
        name: "GitHub",
        resourceKind: "platform",
        accessClass: "public",
        provenance: USER_PROVENANCE,
        idempotencyKey: "create-github",
      } as const;
      catalog.change(base);
      expectCode(
        () => catalog.change({ ...base, name: "GitHub changed" }),
        "IDEMPOTENCY_KEY_CONFLICT",
      );
      expectCode(
        () => catalog.change({ ...base, idempotencyKey: "duplicate-key" }),
        "RESOURCE_KEY_CONFLICT",
      );
    } finally {
      database.close();
    }
  });

  it("replays the immutable result after reopening the catalog", () => {
    const database = openDatabase(":memory:");
    try {
      const input = {
        kind: "create",
        resourceKey: "platform:github",
        name: "GitHub",
        resourceKind: "platform",
        accessClass: "public",
        provenance: USER_PROVENANCE,
        idempotencyKey: "create-github",
      } as const;
      const receipt = commands(database.connection).change(input);
      expect(commands(database.connection).change(input)).toEqual(receipt);
    } finally {
      database.close();
    }
  });

  it.each([
    "afterResourceEventInsert",
    "afterResourceHeadAdvance",
    "afterResourcePreferenceInsert",
    "beforeReceiptInsert",
    "afterReceiptInsert",
  ] as const)("rolls back every create write when %s fails", (boundary) => {
    const database = openDatabase(":memory:");
    try {
      const hooks: ResourceCommandCatalogTestHooks = {};
      if (boundary === "afterResourceEventInsert") {
        hooks.afterResourceEventInsert = () => {
          throw new Error("injected create event failure");
        };
      } else if (boundary === "afterResourceHeadAdvance") {
        hooks.afterResourceHeadAdvance = () => {
          throw new Error("injected create head failure");
        };
      } else if (boundary === "afterResourcePreferenceInsert") {
        hooks.afterResourcePreferenceInsert = () => {
          throw new Error("injected create preference failure");
        };
      } else if (boundary === "beforeReceiptInsert") {
        hooks.beforeReceiptInsert = () => {
          throw new Error("injected pre-receipt failure");
        };
      } else {
        hooks.afterReceiptInsert = () => {
          throw new Error("injected post-receipt failure");
        };
      }
      expect(() =>
        commands(database.connection, hooks).change({
          kind: "create",
          resourceKey: "platform:rollback",
          name: "Rollback",
          resourceKind: "platform",
          accessClass: "public",
          provenance: USER_PROVENANCE,
          idempotencyKey: `create-${boundary}`,
        }),
      ).toThrow(/injected/);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resources WHERE resource_key = 'platform:rollback'")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_command_receipts WHERE idempotency_key = ?")
          .pluck()
          .get(`create-${boundary}`),
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("ResourceCommandCatalog rename", () => {
  it("appends a direct full-snapshot successor and supports canonical no-op", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const changed = catalog.change({
        kind: "rename",
        resourceId: resource.id,
        expectedVersion: 1,
        name: "  GitHub Platform  ",
        provenance: AGENT_PROVENANCE,
        idempotencyKey: "rename-github",
      });
      expect(changed.result).toMatchObject({
        kind: "rename",
        changed: true,
        resource: {
          version: 2,
          resource: { name: "GitHub Platform", kind: "platform" },
        },
      });
      expect(
        database.connection
          .prepare(`
            SELECT version, name, kind, access_class, lifecycle_state,
              created_by, creation_method, supersedes_id
            FROM resource_events
            WHERE resource_id = ? ORDER BY version
          `)
          .all(resource.id),
      ).toEqual([
        expect.objectContaining({ version: 1, name: "GitHub" }),
        expect.objectContaining({
          version: 2,
          name: "GitHub Platform",
          kind: "platform",
          access_class: "public",
          lifecycle_state: "active",
          created_by: "agent",
          creation_method: "on_behalf_of_user",
          supersedes_id: expect.any(Number),
        }),
      ]);

      const noOp = catalog.change({
        kind: "rename",
        resourceId: resource.id,
        expectedVersion: 2,
        name: " GitHub Platform ",
        provenance: USER_PROVENANCE,
        idempotencyKey: "rename-github-noop",
      });
      expect(noOp.result).toMatchObject({
        kind: "rename",
        changed: false,
        resource: { version: 2 },
      });
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_events WHERE resource_id = ?")
          .pluck()
          .get(resource.id),
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it("checks CAS before no-op, but exact replay wins after later changes", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const firstCommand: Extract<
        ResourceCatalogCommand,
        { kind: "rename" }
      > = {
        kind: "rename",
        resourceId: resource.id,
        expectedVersion: 1,
        name: "GitHub One",
        provenance: USER_PROVENANCE,
        idempotencyKey: "rename-one",
      };
      const first = catalog.change(firstCommand);
      catalog.change({
        ...firstCommand,
        expectedVersion: 2,
        name: "GitHub Two",
        idempotencyKey: "rename-two",
      });
      expect(catalog.change(firstCommand)).toEqual(first);
      expectCode(
        () =>
          catalog.change({
            ...firstCommand,
            name: "GitHub Two",
            idempotencyKey: "stale-noop",
          }),
        "RESOURCE_VERSION_CONFLICT",
      );
    } finally {
      database.close();
    }
  });

  it("rejects missing, stale and merged resources with typed errors", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "platform:source",
        name: "Source",
        idempotencyKey: "create-source",
      });
      const target = createResource(database.connection, {
        key: "platform:target",
        name: "Target",
        idempotencyKey: "create-target",
      });
      const catalog = commands(database.connection);
      const base = {
        kind: "rename",
        name: "Renamed",
        provenance: USER_PROVENANCE,
      } as const;
      expectCode(
        () =>
          catalog.change({
            ...base,
            resourceId: 999_999,
            expectedVersion: 1,
            idempotencyKey: "rename-missing",
          }),
        "RESOURCE_NOT_FOUND",
      );
      expectCode(
        () =>
          catalog.change({
            ...base,
            resourceId: source.id,
            expectedVersion: 2,
            idempotencyKey: "rename-stale",
          }),
        "RESOURCE_VERSION_CONFLICT",
      );

      const currentEventId = database.connection
        .prepare("SELECT event_id FROM resource_heads WHERE resource_id = ?")
        .pluck()
        .get(source.id) as number;
      const mergedEventId = Number(
        database.connection
          .prepare(`
            INSERT INTO resource_events (
              resource_id, version, name, kind, access_class, lifecycle_state,
              merged_into_resource_id, created_by, creation_method,
              supersedes_id, created_at
            ) VALUES (?, 2, 'Source', 'platform', 'public', 'merged', ?,
              'user', 'manual', ?, ?)
          `)
          .run(source.id, target.id, currentEventId, NOW).lastInsertRowid,
      );
      database.connection
        .prepare("UPDATE resource_heads SET event_id = ? WHERE resource_id = ?")
        .run(mergedEventId, source.id);
      expectCode(
        () =>
          catalog.change({
            ...base,
            resourceId: source.id,
            expectedVersion: 2,
            idempotencyKey: "rename-merged",
          }),
        "RESOURCE_NOT_ACTIVE",
      );
    } finally {
      database.close();
    }
  });

  it.each([
    "afterResourceEventInsert",
    "afterResourceHeadAdvance",
    "afterReceiptInsert",
  ] as const)("rolls back rename history and receipt when %s fails", (boundary) => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:rollback",
        name: "Before",
        idempotencyKey: `create-rename-${boundary}`,
      });
      const hooks: ResourceCommandCatalogTestHooks = {};
      if (boundary === "afterResourceEventInsert") {
        hooks.afterResourceEventInsert = (operation) => {
          if (operation === "rename") throw new Error("injected rename event");
        };
      } else if (boundary === "afterResourceHeadAdvance") {
        hooks.afterResourceHeadAdvance = (operation) => {
          if (operation === "rename") throw new Error("injected rename head");
        };
      } else {
        hooks.afterReceiptInsert = () => {
          throw new Error("injected rename receipt");
        };
      }
      expect(() =>
        commands(database.connection, hooks).change({
          kind: "rename",
          resourceId: resource.id,
          expectedVersion: 1,
          name: "After",
          provenance: USER_PROVENANCE,
          idempotencyKey: `rename-${boundary}`,
        }),
      ).toThrow(/injected/);
      expect(
        database.connection
          .prepare(`
            SELECT events.version, events.name
            FROM resource_heads AS heads
            JOIN resource_events AS events ON events.id = heads.event_id
            WHERE heads.resource_id = ?
          `)
          .get(resource.id),
      ).toEqual({ version: 1, name: "Before" });
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_events WHERE resource_id = ?")
          .pluck()
          .get(resource.id),
      ).toBe(1);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_command_receipts WHERE idempotency_key = ?")
          .pluck()
          .get(`rename-${boundary}`),
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("ResourceCommandCatalog set_aliases", () => {
  it("normalizes full desired aliases, maps provenance and bumps ruleset once", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const receipt = catalog.change({
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 1,
        aliases: [
          {
            hostPattern: "Docs.Example.com.",
            matchKind: "exact_host",
            pathPrefix: "/team/",
            priority: 20,
          },
          {
            hostPattern: "GitHub.COM",
            matchKind: "suffix_host",
            pathPrefix: "/",
            priority: 10,
          },
        ],
        provenance: AGENT_PROVENANCE,
        idempotencyKey: "aliases-github",
      });
      expect(receipt.result).toEqual({
        kind: "set_aliases",
        changed: true,
        resourceId: resource.id,
        aliases: [
          {
            hostPattern: "docs.example.com",
            matchKind: "exact_host",
            pathPrefix: "/team",
            priority: 20,
          },
          {
            hostPattern: "github.com",
            matchKind: "suffix_host",
            pathPrefix: "/",
            priority: 10,
          },
        ],
        rulesetVersion: 2,
      });
      expect(currentRulesetVersion(database.connection)).toBe(2);
      expect(
        database.connection
          .prepare(`
            SELECT provenance_class, created_by, creation_method, enabled
            FROM resource_match_rules WHERE resource_id = ? ORDER BY rule_key
          `)
          .all(resource.id),
      ).toEqual([
        {
          provenance_class: "agent_alias",
          created_by: "agent",
          creation_method: "on_behalf_of_user",
          enabled: 1,
        },
        {
          provenance_class: "agent_alias",
          created_by: "agent",
          creation_method: "on_behalf_of_user",
          enabled: 1,
        },
      ]);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_ruleset_events")
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it("treats alias order/case/trailing slash as normalized replay and no-op", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const firstCommand: Extract<
        ResourceCatalogCommand,
        { kind: "set_aliases" }
      > = {
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 1,
        aliases: [
          {
            hostPattern: "Docs.Example.com.",
            matchKind: "exact_host",
            pathPrefix: "/team/",
            priority: 20,
          },
          {
            hostPattern: "github.com",
            matchKind: "suffix_host",
            pathPrefix: "/",
            priority: 10,
          },
        ],
        provenance: USER_PROVENANCE,
        idempotencyKey: "aliases-first",
      };
      const first = catalog.change(firstCommand);
      const docsAlias = firstCommand.aliases[0]!;
      const githubAlias = firstCommand.aliases[1]!;
      expect(
        catalog.change({
          ...firstCommand,
          aliases: [
            githubAlias,
            {
              ...docsAlias,
              hostPattern: "docs.example.com",
              pathPrefix: "/team",
            },
          ],
        }),
      ).toEqual(first);

      const noOp = catalog.change({
        ...firstCommand,
        expectedRulesetVersion: 2,
        idempotencyKey: "aliases-noop",
      });
      expect(noOp.result).toMatchObject({
        kind: "set_aliases",
        changed: false,
        rulesetVersion: 2,
      });
      expect(currentRulesetVersion(database.connection)).toBe(2);
      expectCode(
        () =>
          catalog.change({
            ...firstCommand,
            idempotencyKey: "aliases-stale-noop",
          }),
        "RESOURCE_RULESET_VERSION_CONFLICT",
      );
    } finally {
      database.close();
    }
  });

  it("preserves stable rule_key through disable and agent re-enable successors", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const alias = {
        hostPattern: "github.com",
        matchKind: "suffix_host",
        pathPrefix: "/",
        priority: 10,
      } as const;
      catalog.change({
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 1,
        aliases: [alias],
        provenance: USER_PROVENANCE,
        idempotencyKey: "aliases-enable",
      });
      catalog.change({
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 2,
        aliases: [],
        provenance: USER_PROVENANCE,
        idempotencyKey: "aliases-disable",
      });
      catalog.change({
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 3,
        aliases: [{ ...alias, priority: 25 }],
        provenance: AGENT_PROVENANCE,
        idempotencyKey: "aliases-reenable",
      });

      const history = database.connection
        .prepare(`
          SELECT rule_key, version, priority, provenance_class, created_by,
            creation_method, enabled, supersedes_id
          FROM resource_match_rules
          WHERE resource_id = ? ORDER BY version
        `)
        .all(resource.id) as Array<Record<string, unknown>>;
      expect(history).toHaveLength(3);
      expect(new Set(history.map((row) => row.rule_key)).size).toBe(1);
      expect(history).toEqual([
        expect.objectContaining({
          version: 1,
          priority: 10,
          provenance_class: "user_alias",
          enabled: 1,
          supersedes_id: null,
        }),
        expect.objectContaining({
          version: 2,
          priority: 10,
          provenance_class: "user_alias",
          enabled: 0,
          supersedes_id: expect.any(Number),
        }),
        expect.objectContaining({
          version: 3,
          priority: 25,
          provenance_class: "agent_alias",
          created_by: "agent",
          creation_method: "on_behalf_of_user",
          enabled: 1,
          supersedes_id: expect.any(Number),
        }),
      ]);
      expect(currentRulesetVersion(database.connection)).toBe(4);
    } finally {
      database.close();
    }
  });

  it("returns exact pre-CAS replay after later ruleset changes", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const firstCommand: Extract<
        ResourceCatalogCommand,
        { kind: "set_aliases" }
      > = {
        kind: "set_aliases",
        resourceId: resource.id,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 1,
        aliases: [
          {
            hostPattern: "github.com",
            matchKind: "suffix_host",
            pathPrefix: "/",
            priority: 10,
          },
        ],
        provenance: USER_PROVENANCE,
        idempotencyKey: "aliases-first",
      };
      const first = catalog.change(firstCommand);
      catalog.change({
        ...firstCommand,
        expectedRulesetVersion: 2,
        aliases: [],
        idempotencyKey: "aliases-second",
      });
      expect(catalog.change(firstCommand)).toEqual(first);
      expect(currentRulesetVersion(database.connection)).toBe(3);
    } finally {
      database.close();
    }
  });

  it("checks resource CAS/activity and rejects unsafe alias authority", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:github",
        name: "GitHub",
        idempotencyKey: "create-github",
      });
      const catalog = commands(database.connection);
      const base: Omit<
        Extract<ResourceCatalogCommand, { kind: "set_aliases" }>,
        "expectedResourceVersion" | "idempotencyKey"
      > = {
        kind: "set_aliases",
        resourceId: resource.id,
        expectedRulesetVersion: 1,
        aliases: [],
        provenance: USER_PROVENANCE,
      };
      expectCode(
        () =>
          catalog.change({
            ...base,
            expectedResourceVersion: 2,
            idempotencyKey: "aliases-stale-resource",
          }),
        "RESOURCE_VERSION_CONFLICT",
      );
      for (const hostPattern of ["*.example.com", "127.0.0.1", "com"]) {
        expectCode(
          () =>
            catalog.change({
              ...base,
              expectedResourceVersion: 1,
              aliases: [
                {
                  hostPattern,
                  matchKind: "suffix_host",
                  pathPrefix: "/",
                  priority: 1,
                },
              ],
              idempotencyKey: `aliases-invalid-${hostPattern}`,
            }),
          "RESOURCE_ALIAS_INVALID",
        );
      }
      expect(currentRulesetVersion(database.connection)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("allows equal current patterns on different resources and reprojects ambiguity", () => {
    const database = openDatabase(":memory:");
    try {
      const first = createResource(database.connection, {
        key: "platform:first",
        name: "First",
        idempotencyKey: "create-first",
      });
      const second = createResource(database.connection, {
        key: "platform:second",
        name: "Second",
        idempotencyKey: "create-second",
      });
      const pageId = seedPage(database.connection, "https://shared.example.com/team");
      const catalog = commands(database.connection);
      const base: Omit<
        Extract<ResourceCatalogCommand, { kind: "set_aliases" }>,
        "resourceId" | "expectedRulesetVersion" | "idempotencyKey"
      > = {
        kind: "set_aliases",
        expectedResourceVersion: 1,
        aliases: [
          {
            hostPattern: "shared.example.com",
            matchKind: "exact_host",
            pathPrefix: "/",
            priority: 10,
          },
        ],
        provenance: USER_PROVENANCE,
      };
      catalog.change({
        ...base,
        resourceId: first.id,
        expectedRulesetVersion: 1,
        idempotencyKey: "aliases-first",
      });
      catalog.change({
        ...base,
        resourceId: second.id,
        expectedRulesetVersion: 2,
        idempotencyKey: "aliases-second",
      });

      const resolver = createResourceCatalog(database.connection);
      expect(resolver.getResolution(pageId)).toMatchObject({
        state: "ambiguous",
        reason: "authoritative_tie",
        candidateResourceIds: [first.id, second.id],
      });
      const reviewItem = resolver.list({
        resolution: "unmatched_or_ambiguous",
        page: 1,
        pageSize: 20,
      }).items[0]!;
      expect(reviewItem).toMatchObject({
        logicalPageId: pageId,
        state: "ambiguous",
        candidateResourceIds: [first.id, second.id],
      });
      expect(reviewItem.currentAssignmentId).toEqual(expect.any(Number));

      expect(catalog.change({
        kind: "apply_override",
        logicalPageId: pageId,
        resourceId: first.id,
        expectedAssignmentId: reviewItem.currentAssignmentId,
        provenance: USER_PROVENANCE,
        idempotencyKey: "resolve-ambiguous-from-review",
      }).result).toMatchObject({
        kind: "apply_override",
        changed: true,
        resolution: { state: "resolved", reason: "user_manual" },
      });
      expectCode(() => catalog.change({
        kind: "apply_override",
        logicalPageId: pageId,
        resourceId: second.id,
        expectedAssignmentId: reviewItem.currentAssignmentId,
        provenance: USER_PROVENANCE,
        idempotencyKey: "resolve-ambiguous-stale",
      }), "RESOURCE_ASSIGNMENT_CONFLICT");
    } finally {
      database.close();
    }
  });

  it.each([
    "afterRuleEventInsert",
    "afterRulesetEventInsert",
    "afterReceiptInsert",
  ] as const)("rolls back aliases, ruleset and receipt when %s fails", (boundary) => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:rollback",
        name: "Rollback",
        idempotencyKey: `create-${boundary}`,
      });
      const hooks: ResourceCommandCatalogTestHooks = {};
      hooks[boundary] = () => {
        throw new Error(`injected ${boundary}`);
      };
      expect(() =>
        commands(database.connection, hooks).change({
          kind: "set_aliases",
          resourceId: resource.id,
          expectedResourceVersion: 1,
          expectedRulesetVersion: 1,
          aliases: [
            {
              hostPattern: "rollback.example.com",
              matchKind: "exact_host",
              pathPrefix: "/",
              priority: 10,
            },
          ],
          provenance: USER_PROVENANCE,
          idempotencyKey: `aliases-${boundary}`,
        }),
      ).toThrow(/injected/);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_match_rules WHERE resource_id = ?")
          .pluck()
          .get(resource.id),
      ).toBe(0);
      expect(currentRulesetVersion(database.connection)).toBe(1);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_command_receipts WHERE idempotency_key = ?")
          .pluck()
          .get(`aliases-${boundary}`),
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("ResourceCommandCatalog apply_override", () => {
  it("appends a manual override, preserves it through backfill, and explicitly clears it", () => {
    const database = openDatabase(":memory:");
    try {
      const resolver = createResourceCatalog(database.connection, () => new Date(NOW));
      const pageId = seedPage(database.connection, "https://youtube.com/watch?v=1");
      resolver.resolvePage(pageId);
      const automaticAssignmentId = currentAssignmentId(database.connection, pageId);
      const custom = createResource(database.connection, {
        key: "platform:video-notes",
        name: "Video Notes",
        idempotencyKey: "create-video-notes",
      });
      const catalog = commands(database.connection);
      const applyCommand = {
        kind: "apply_override",
        logicalPageId: pageId,
        resourceId: custom.id,
        expectedAssignmentId: automaticAssignmentId,
        provenance: USER_PROVENANCE,
        idempotencyKey: "override-video",
      } as const;
      const applied = catalog.change(applyCommand);
      expect(applied.result).toMatchObject({
        kind: "apply_override",
        changed: true,
        resource: { version: 1, resource: { id: custom.id } },
        resolution: { state: "resolved", reason: "user_manual" },
      });
      const overrideAssignmentId = currentAssignmentId(database.connection, pageId);
      resolver.backfill();
      expect(currentMembershipResource(database.connection, pageId)).toBe(custom.id);
      expect(currentAssignmentId(database.connection, pageId)).toBe(overrideAssignmentId);
      expect(commands(database.connection).change(applyCommand)).toEqual(applied);

      expectCode(
        () =>
          catalog.change({
            ...applyCommand,
            idempotencyKey: "override-stale",
          }),
        "RESOURCE_ASSIGNMENT_CONFLICT",
      );
      const cleared = catalog.change({
        kind: "apply_override",
        logicalPageId: pageId,
        resourceId: null,
        expectedAssignmentId: overrideAssignmentId,
        provenance: USER_PROVENANCE,
        idempotencyKey: "clear-video-override",
      });
      expect(cleared.result).toMatchObject({
        kind: "apply_override",
        changed: true,
        resource: null,
        resolution: { state: "resolved", reason: "system_seed" },
      });
      expect(currentMembershipResource(database.connection, pageId)).not.toBe(custom.id);
      expect(
        database.connection
          .prepare(`
            SELECT action, resource_id, provenance_class
            FROM logical_page_resource_assignments
            WHERE logical_page_id = ? ORDER BY id
          `)
          .all(pageId),
      ).toEqual([
        expect.objectContaining({ action: "assigned", provenance_class: "system_seed" }),
        expect.objectContaining({
          action: "assigned",
          resource_id: custom.id,
          provenance_class: "user_manual",
        }),
        expect.objectContaining({ action: "removed", resource_id: null }),
        expect.objectContaining({ action: "assigned", provenance_class: "system_seed" }),
      ]);
      expect(() => database.connection.pragma("foreign_key_check")).not.toThrow();
    } finally {
      database.close();
    }
  });

  it.each(["afterAssignmentInsert", "afterAssignmentHeadAdvance", "afterReceiptInsert"] as const)(
    "rolls back override and resolution when %s fails",
    (boundary) => {
      const database = openDatabase(":memory:");
      try {
        const pageId = seedPage(database.connection, "https://example.com/a");
        const resolver = createResourceCatalog(database.connection, () => new Date(NOW));
        resolver.resolvePage(pageId);
        const before = currentAssignmentId(database.connection, pageId);
        const target = createResource(database.connection, {
          key: "platform:override-target",
          name: "Override Target",
          idempotencyKey: `create-override-target-${boundary}`,
        });
        const hooks: ResourceCommandCatalogTestHooks = {};
        if (boundary === "afterAssignmentInsert") {
          hooks.afterAssignmentInsert = () => { throw new Error("injected assignment"); };
        } else if (boundary === "afterAssignmentHeadAdvance") {
          hooks.afterAssignmentHeadAdvance = () => { throw new Error("injected head"); };
        } else {
          hooks.afterReceiptInsert = () => { throw new Error("injected receipt"); };
        }
        expect(() =>
          commands(database.connection, hooks).change({
            kind: "apply_override",
            logicalPageId: pageId,
            resourceId: target.id,
            expectedAssignmentId: before,
            provenance: USER_PROVENANCE,
            idempotencyKey: `override-${boundary}`,
          }),
        ).toThrow(/injected/);
        expect(currentAssignmentId(database.connection, pageId)).toBe(before);
        expect(
          database.connection.prepare(
            "SELECT COUNT(*) FROM resource_command_receipts WHERE idempotency_key = ?",
          ).pluck().get(`override-${boundary}`),
        ).toBe(0);
      } finally {
        database.close();
      }
    },
  );
});

describe("ResourceCommandCatalog merge", () => {
  it("merges lifecycle, enabled aliases and memberships while preserving source-owned data", () => {
    const database = openDatabase(":memory:");
    try {
      const sourceId = database.connection
        .prepare("SELECT id FROM resources WHERE resource_key = 'platform:youtube'")
        .pluck().get() as number;
      const target = createResource(database.connection, {
        key: "platform:video",
        name: "Video",
        idempotencyKey: "create-video",
      });
      const pages = [
        seedPage(database.connection, "https://youtube.com/watch?v=1"),
        seedPage(database.connection, "https://youtu.be/2"),
      ];
      createResourceCatalog(database.connection, () => new Date(NOW)).backfill();
      const preferenceBefore = database.connection
        .prepare("SELECT * FROM resource_preferences WHERE resource_id = ?")
        .get(sourceId);
      database.connection.prepare(`
        INSERT INTO resource_context_entries (
          resource_id, kind, body, actor, method, visibility, state, operation,
          revision, idempotency_key, created_at
        ) VALUES (?, 'note', 'source context', 'user', 'manual', 'local_only',
          'active', 'append', 1, 'source-context', ?)
      `).run(sourceId, NOW);
      const contextBefore = database.connection
        .prepare("SELECT * FROM resource_context_entries WHERE resource_id = ?")
        .all(sourceId);
      const topicsBefore = JSON.stringify({
        tags: database.connection.prepare("SELECT * FROM tags ORDER BY id").all(),
        memberships: database.connection.prepare("SELECT * FROM tab_tags ORDER BY tab_id, tag_id").all(),
      });
      const command = {
        kind: "merge",
        sourceResourceId: sourceId,
        targetResourceId: target.id,
        expectedSourceVersion: 1,
        expectedTargetVersion: 1,
        expectedRulesetVersion: 1,
        provenance: USER_PROVENANCE,
        idempotencyKey: "merge-youtube-video",
      } as const;
      const receipt = commands(database.connection).change(command);
      expect(receipt.result).toMatchObject({
        kind: "merge",
        changed: true,
        source: {
          version: 2,
          resource: { id: sourceId, lifecycleState: "merged", mergedIntoResourceId: target.id },
        },
        target: { version: 1, resource: { id: target.id, lifecycleState: "active" } },
        movedLogicalPageIds: pages,
        rulesetVersion: 2,
      });
      expect(
        database.connection.prepare(`
          SELECT rules.resource_id
          FROM resource_match_rule_heads AS heads
          JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
          WHERE rules.rule_key LIKE 'seed:youtube:%' ORDER BY rules.rule_key
        `).pluck().all(),
      ).toEqual([target.id, target.id]);
      expect(pages.map((id) => currentMembershipResource(database.connection, id)))
        .toEqual([target.id, target.id]);
      expect(
        database.connection.prepare(`
          SELECT COUNT(*) FROM logical_page_resource_assignments
          WHERE logical_page_id IN (?, ?) AND resource_id = ?
        `).pluck().get(pages[0], pages[1], sourceId),
      ).toBe(2);
      expect(database.connection
        .prepare("SELECT * FROM resource_preferences WHERE resource_id = ?")
        .get(sourceId)).toEqual(preferenceBefore);
      expect(database.connection
        .prepare("SELECT * FROM resource_context_entries WHERE resource_id = ?")
        .all(sourceId)).toEqual(contextBefore);
      expect(JSON.stringify({
        tags: database.connection.prepare("SELECT * FROM tags ORDER BY id").all(),
        memberships: database.connection.prepare("SELECT * FROM tab_tags ORDER BY tab_id, tag_id").all(),
      })).toBe(topicsBefore);
      createResourceCatalog(database.connection, () => new Date(NOW)).backfill();
      expect(pages.map((id) => currentMembershipResource(database.connection, id)))
        .toEqual([target.id, target.id]);
      expect(commands(database.connection).change(command)).toEqual(receipt);
      expectCode(
        () => commands(database.connection).change({ ...command, idempotencyKey: "merge-again" }),
        "RESOURCE_NOT_ACTIVE",
      );
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects stale and chained merges and rolls back late failure", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "platform:merge-source", name: "Source", idempotencyKey: "create-merge-source",
      });
      const target = createResource(database.connection, {
        key: "platform:merge-target", name: "Target", idempotencyKey: "create-merge-target",
      });
      const pageId = seedPage(database.connection, "https://merge.example/a");
      commands(database.connection).change({
        kind: "apply_override", logicalPageId: pageId, resourceId: source.id,
        expectedAssignmentId: null, provenance: USER_PROVENANCE,
        idempotencyKey: "assign-merge-source",
      });
      const base = {
        kind: "merge", sourceResourceId: source.id, targetResourceId: target.id,
        expectedSourceVersion: 1, expectedTargetVersion: 1,
        expectedRulesetVersion: 1, provenance: USER_PROVENANCE,
      } as const;
      expectCode(
        () => commands(database.connection).change({ ...base, expectedSourceVersion: 2, idempotencyKey: "merge-stale" }),
        "RESOURCE_VERSION_CONFLICT",
      );
      const hooks: ResourceCommandCatalogTestHooks = {
        afterReceiptInsert: () => { throw new Error("injected merge receipt"); },
      };
      expect(() => commands(database.connection, hooks).change({ ...base, idempotencyKey: "merge-fault" }))
        .toThrow(/injected/);
      expect(currentMembershipResource(database.connection, pageId)).toBe(source.id);
      expect(
        database.connection.prepare(`
          SELECT events.lifecycle_state FROM resource_heads AS heads
          JOIN resource_events AS events ON events.id = heads.event_id
          WHERE heads.resource_id = ?
        `).pluck().get(source.id),
      ).toBe("active");
      commands(database.connection).change({ ...base, idempotencyKey: "merge-success" });
      expectCode(
        () => commands(database.connection).change({
          ...base,
          sourceResourceId: target.id,
          targetResourceId: source.id,
          idempotencyKey: "merge-chain",
        }),
        "RESOURCE_NOT_ACTIVE",
      );
    } finally {
      database.close();
    }
  });

  it("retains overlapping alias histories and later canonicalizes the target snapshot", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "platform:overlap-source", name: "Source", idempotencyKey: "create-overlap-source",
      });
      const target = createResource(database.connection, {
        key: "platform:overlap-target", name: "Target", idempotencyKey: "create-overlap-target",
      });
      const catalog = commands(database.connection);
      const alias = [{
        hostPattern: "overlap.example.com", matchKind: "exact_host" as const,
        pathPrefix: "/", priority: 5,
      }];
      catalog.change({
        kind: "set_aliases", resourceId: source.id, expectedResourceVersion: 1,
        expectedRulesetVersion: 1, aliases: alias, provenance: USER_PROVENANCE,
        idempotencyKey: "source-overlap-alias",
      });
      catalog.change({
        kind: "set_aliases", resourceId: target.id, expectedResourceVersion: 1,
        expectedRulesetVersion: 2, aliases: alias, provenance: USER_PROVENANCE,
        idempotencyKey: "target-overlap-alias",
      });
      catalog.change({
        kind: "merge", sourceResourceId: source.id, targetResourceId: target.id,
        expectedSourceVersion: 1, expectedTargetVersion: 1,
        expectedRulesetVersion: 3, provenance: USER_PROVENANCE,
        idempotencyKey: "merge-overlap",
      });
      expect(currentRulesetVersion(database.connection)).toBe(4);
      const canonicalized = catalog.change({
        kind: "set_aliases", resourceId: target.id, expectedResourceVersion: 1,
        expectedRulesetVersion: 4, aliases: alias, provenance: USER_PROVENANCE,
        idempotencyKey: "canonicalize-overlap",
      });
      expect(canonicalized.result).toMatchObject({
        kind: "set_aliases", changed: true, rulesetVersion: 5,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_match_rule_heads AS heads
        JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
        WHERE rules.resource_id = ? AND rules.enabled = 1
          AND rules.host_pattern = 'overlap.example.com'
      `).pluck().get(target.id)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("atomically reprojects rule-only ambiguous pages after alias retargeting", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "platform:ambiguous-source", name: "Source", idempotencyKey: "create-ambiguous-source",
      });
      const target = createResource(database.connection, {
        key: "platform:ambiguous-target", name: "Target", idempotencyKey: "create-ambiguous-target",
      });
      const pageId = seedPage(database.connection, "https://tie.example.com/docs");
      const catalog = commands(database.connection);
      const alias = [{
        hostPattern: "tie.example.com", matchKind: "exact_host" as const,
        pathPrefix: "/docs", priority: 10,
      }];
      catalog.change({
        kind: "set_aliases", resourceId: source.id, expectedResourceVersion: 1,
        expectedRulesetVersion: 1, aliases: alias, provenance: USER_PROVENANCE,
        idempotencyKey: "ambiguous-source-alias",
      });
      catalog.change({
        kind: "set_aliases", resourceId: target.id, expectedResourceVersion: 1,
        expectedRulesetVersion: 2, aliases: alias, provenance: USER_PROVENANCE,
        idempotencyKey: "ambiguous-target-alias",
      });
      const resolver = createResourceCatalog(database.connection, () => new Date(NOW));
      expect(resolver.resolvePage(pageId)).toMatchObject({
        state: "ambiguous",
        candidateResourceIds: [source.id, target.id].sort((a, b) => a - b),
      });
      expect(currentMembershipResource(database.connection, pageId)).toBeNull();

      const merged = catalog.change({
        kind: "merge", sourceResourceId: source.id, targetResourceId: target.id,
        expectedSourceVersion: 1, expectedTargetVersion: 1,
        expectedRulesetVersion: 3, provenance: USER_PROVENANCE,
        idempotencyKey: "merge-ambiguous-source",
      });
      expect(merged.result).toMatchObject({
        kind: "merge", movedLogicalPageIds: [], rulesetVersion: 4,
      });
      expect(resolver.getResolution(pageId)).toMatchObject({
        state: "resolved",
        reason: "explicit_alias",
        candidateResourceIds: [target.id],
        resource: { id: target.id },
      });

      const reopened = createResourceCatalog(database.connection, () => new Date(NOW));
      expect(reopened.getResolution(pageId)).toMatchObject({
        state: "resolved",
        candidateResourceIds: [target.id],
        resource: { id: target.id },
      });
      expect(reopened.backfill().unchanged).toBeGreaterThanOrEqual(1);
    } finally {
      database.close();
    }
  });
});

describe("ResourceCommandCatalog split", () => {
  it("moves only explicitly selected memberships to existing and new active targets", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "collection:source", name: "Source", idempotencyKey: "create-split-source",
      });
      const existing = createResource(database.connection, {
        key: "collection:existing", name: "Existing", idempotencyKey: "create-split-existing",
      });
      const pages = [1, 2, 3].map((value) =>
        seedPage(database.connection, `https://split.example/${value}`),
      );
      const catalog = commands(database.connection);
      for (const pageId of pages) {
        catalog.change({
          kind: "apply_override", logicalPageId: pageId, resourceId: source.id,
          expectedAssignmentId: null, provenance: USER_PROVENANCE,
          idempotencyKey: `assign-split-${pageId}`,
        });
      }
      const existingCommand: Extract<
        ResourceCatalogCommand,
        { kind: "split" }
      > = {
        kind: "split", sourceResourceId: source.id, expectedSourceVersion: 1,
        logicalPageIds: [pages[2]!, pages[0]!, pages[0]!],
        target: { kind: "existing", resourceId: existing.id, expectedVersion: 1 },
        provenance: USER_PROVENANCE, idempotencyKey: "split-existing",
      };
      const first = catalog.change(existingCommand);
      expect(first.result).toMatchObject({
        kind: "split", changed: true, movedLogicalPageIds: [pages[0], pages[2]],
        source: { version: 1, resource: { lifecycleState: "active" } },
        target: { version: 1, resource: { id: existing.id, lifecycleState: "active" } },
      });
      expect(pages.map((id) => currentMembershipResource(database.connection, id)))
        .toEqual([existing.id, source.id, existing.id]);
      expect(commands(database.connection).change(existingCommand)).toEqual(first);

      const created = catalog.change({
        kind: "split", sourceResourceId: source.id, expectedSourceVersion: 1,
        logicalPageIds: [pages[1]!],
        target: {
          kind: "new", resourceKey: " COLLECTION:NEW-TARGET ", name: " New Target ",
          resourceKind: "collection", accessClass: "public",
        },
        provenance: USER_PROVENANCE, idempotencyKey: "split-new",
      });
      expect(created.result).toMatchObject({
        kind: "split", movedLogicalPageIds: [pages[1]],
        target: { version: 1, resource: { resourceKey: "collection:new-target", lifecycleState: "active" } },
      });
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects nonmembers and rolls back an atomic new-target split", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "collection:fault-source", name: "Fault Source", idempotencyKey: "create-fault-source",
      });
      const pageId = seedPage(database.connection, "https://fault.example/page");
      expectCode(
        () => commands(database.connection).change({
          kind: "split", sourceResourceId: source.id, expectedSourceVersion: 1,
          logicalPageIds: [pageId],
          target: { kind: "new", resourceKey: "collection:not-created", name: "No", resourceKind: "collection", accessClass: "public" },
          provenance: USER_PROVENANCE, idempotencyKey: "split-nonmember",
        }),
        "RESOURCE_MEMBERSHIP_CONFLICT",
      );
      commands(database.connection).change({
        kind: "apply_override", logicalPageId: pageId, resourceId: source.id,
        expectedAssignmentId: null, provenance: USER_PROVENANCE, idempotencyKey: "assign-fault-source",
      });
      const beforeAssignment = currentAssignmentId(database.connection, pageId);
      expect(() => commands(database.connection, {
        afterReceiptInsert: () => { throw new Error("injected split receipt"); },
      }).change({
        kind: "split", sourceResourceId: source.id, expectedSourceVersion: 1,
        logicalPageIds: [pageId],
        target: { kind: "new", resourceKey: "collection:rolled-back", name: "Rolled Back", resourceKind: "collection", accessClass: "public" },
        provenance: USER_PROVENANCE, idempotencyKey: "split-fault",
      })).toThrow(/injected/);
      expect(currentAssignmentId(database.connection, pageId)).toBe(beforeAssignment);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM resources WHERE resource_key = 'collection:rolled-back'",
      ).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("returns typed stale CAS errors for source and existing target", () => {
    const database = openDatabase(":memory:");
    try {
      const source = createResource(database.connection, {
        key: "collection:stale-source", name: "Source", idempotencyKey: "create-stale-source",
      });
      const target = createResource(database.connection, {
        key: "collection:stale-target", name: "Target", idempotencyKey: "create-stale-target",
      });
      const pageId = seedPage(database.connection, "https://stale.example/page");
      const catalog = commands(database.connection);
      catalog.change({
        kind: "apply_override", logicalPageId: pageId, resourceId: source.id,
        expectedAssignmentId: null, provenance: USER_PROVENANCE, idempotencyKey: "assign-stale-source",
      });
      const base = {
        kind: "split" as const,
        sourceResourceId: source.id,
        logicalPageIds: [pageId] as number[],
        target: {
          kind: "existing" as const,
          resourceId: target.id,
          expectedVersion: 1,
        },
        provenance: USER_PROVENANCE,
      };
      expectCode(
        () => catalog.change({ ...base, expectedSourceVersion: 2, idempotencyKey: "split-stale-source" }),
        "RESOURCE_VERSION_CONFLICT",
      );
      expectCode(
        () => catalog.change({
          ...base, expectedSourceVersion: 1,
          target: { ...base.target, expectedVersion: 2 },
          idempotencyKey: "split-stale-target",
        }),
        "RESOURCE_VERSION_CONFLICT",
      );
      expect(currentMembershipResource(database.connection, pageId)).toBe(source.id);
    } finally {
      database.close();
    }
  });
});

describe("ResourceCommandCatalog receipt safety", () => {
  it("fails closed on malformed result JSON and on kind drift", () => {
    const source = openDatabase(":memory:");
    const malformed = openDatabase(":memory:");
    const drifted = openDatabase(":memory:");
    try {
      const command = {
        kind: "create",
        resourceKey: "platform:github",
        name: "GitHub",
        resourceKind: "platform",
        accessClass: "public",
        provenance: USER_PROVENANCE,
        idempotencyKey: "create-github",
      } as const;
      commands(source.connection).change(command);
      const fingerprint = source.connection
        .prepare(`
          SELECT request_fingerprint FROM resource_command_receipts
          WHERE idempotency_key = ?
        `)
        .pluck()
        .get(command.idempotencyKey) as string;
      malformed.connection
        .prepare(`
          INSERT INTO resource_command_receipts (
            idempotency_key, command_kind, request_fingerprint, result_json,
            created_at
          ) VALUES (?, 'create', ?, '{"bad":true}', ?)
        `)
        .run(command.idempotencyKey, fingerprint, NOW);
      expectCode(
        () => commands(malformed.connection).change(command),
        "RESOURCE_RECEIPT_CORRUPT",
      );

      drifted.connection
        .prepare(`
          INSERT INTO resource_command_receipts (
            idempotency_key, command_kind, request_fingerprint, result_json,
            created_at
          ) VALUES (?, 'rename', ?, '{"kind":"rename"}', ?)
        `)
        .run(command.idempotencyKey, fingerprint, NOW);
      expectCode(
        () => commands(drifted.connection).change(command),
        "RESOURCE_RECEIPT_CORRUPT",
      );
    } finally {
      source.close();
      malformed.close();
      drifted.close();
    }
  });

  it("rejects network-path aliases instead of broadening them to local paths", () => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:authority",
        name: "Authority",
        idempotencyKey: "create-authority",
      });
      expectCode(
        () =>
          commands(database.connection).change({
            kind: "set_aliases",
            resourceId: resource.id,
            expectedResourceVersion: 1,
            expectedRulesetVersion: 1,
            aliases: [{
              hostPattern: "example.com",
              matchKind: "exact_host",
              pathPrefix: "//evil.example/admin",
              priority: 1,
            }],
            provenance: USER_PROVENANCE,
            idempotencyKey: "network-path-alias",
          }),
        "RESOURCE_ALIAS_INVALID",
      );
    } finally {
      database.close();
    }
  });

  it.each([
    { hostPattern: "example.com\u0000", pathPrefix: "/safe" },
    { hostPattern: "example.com", pathPrefix: "/safe\u001F" },
  ])("rejects ASCII controls in alias host/path before URL parsing", (alias) => {
    const database = openDatabase(":memory:");
    try {
      const resource = createResource(database.connection, {
        key: "platform:control",
        name: "Control",
        idempotencyKey: `create-control-${alias.hostPattern.length}-${alias.pathPrefix.length}`,
      });
      expectCode(
        () => commands(database.connection).change({
          kind: "set_aliases",
          resourceId: resource.id,
          expectedResourceVersion: 1,
          expectedRulesetVersion: 1,
          aliases: [{ ...alias, matchKind: "exact_host", priority: 1 }],
          provenance: USER_PROVENANCE,
          idempotencyKey: `control-alias-${alias.hostPattern.length}-${alias.pathPrefix.length}`,
        }),
        "RESOURCE_ALIAS_INVALID",
      );
    } finally {
      database.close();
    }
  });
});
