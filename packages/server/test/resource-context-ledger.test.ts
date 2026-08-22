import { describe, expect, it } from "vitest";

import { createContextLedger, ContextLedgerError } from "../src/context-ledger.js";
import { createResourceCommandCatalog } from "../src/resource-command-catalog.js";
import { openDatabase } from "../src/database.js";

const user = { actor: "user", method: "manual" } as const;
const agent = { actor: "agent", method: "on_behalf_of_user" } as const;

describe("generic ContextLedger resource descriptor", () => {
  it("replays a seeded exact receipt before subject existence checks", () => {
    const database = openDatabase(":memory:", { maximumMigrationVersion: 25 });
    try {
      database.connection.pragma("foreign_keys = OFF");
      database.connection.prepare(`
        INSERT INTO context_entries (
          logical_page_id, kind, body, actor, method, visibility, confidence,
          source_fingerprint, model_provenance_json, stale_at, supersedes_id,
          state, operation, revision, idempotency_key, created_at, withdrawn_at
        ) VALUES (?, 'note', 'seeded replay', 'user', 'manual', 'share_with_ai',
          NULL, NULL, NULL, NULL, NULL, 'active', 'append', 1, ?, ?, NULL)
      `).run(999_999, "seeded-missing-subject", "2026-08-12T10:00:00.000Z");
      const ledger = createContextLedger(database.connection);
      const exact = {
        kind: "append" as const,
        subject: { type: "page" as const, logicalPageId: 999_999 },
        entryKind: "note" as const,
        body: "seeded replay",
        provenance: user,
        visibility: "share_with_ai" as const,
        idempotencyKey: "seeded-missing-subject",
      };
      expect(ledger.change(exact)).toMatchObject({
        kind: "changed",
        entry: { subject: exact.subject, body: exact.body },
      });
      expect(() => ledger.change({ ...exact, body: "different payload" }))
        .toThrowError(expect.objectContaining<Partial<ContextLedgerError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
        }));
      expect(() => ledger.change({ ...exact, idempotencyKey: "new-missing-subject" }))
        .toThrowError(expect.objectContaining<Partial<ContextLedgerError>>({
          code: "LOGICAL_PAGE_NOT_FOUND",
        }));
    } finally {
      database.close();
    }
  });

  it("preserves current-head search/privacy and rejects idempotency reuse across stores", () => {
    const database = openDatabase(":memory:");
    try {
      const pageId = Number(database.connection.prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("https://example.com/one", "https://example.com/one", "https://example.com/one",
        "2026-08-12T10:00:00.000Z", "2026-08-12T10:00:00.000Z").lastInsertRowid);
      const resourceId = Number(database.connection.prepare(
        "SELECT id FROM resources WHERE resource_key = 'platform:youtube'",
      ).pluck().get());
      const ledger = createContextLedger(database.connection, {
        now: () => "2026-08-12T10:00:00.000Z",
      });
      ledger.change({ kind: "append", subject: { type: "page", logicalPageId: pageId },
        entryKind: "note", body: "page key", provenance: user,
        visibility: "share_with_ai", idempotencyKey: "cross-store-entry" });
      expect(() => ledger.change({ kind: "append",
        subject: { type: "resource", resourceId }, entryKind: "note",
        body: "resource key", provenance: user, visibility: "share_with_ai",
        idempotencyKey: "cross-store-entry" })).toThrowError(
          expect.objectContaining<Partial<ContextLedgerError>>({ code: "IDEMPOTENCY_KEY_CONFLICT" }),
        );

      const first = ledger.change({ kind: "append",
        subject: { type: "resource", resourceId }, entryKind: "purpose",
        body: "visible original albatross", provenance: agent,
        visibility: "share_with_ai", idempotencyKey: "resource-first" });
      if (first.kind !== "changed") throw new Error("expected entry");
      const privateReplacement = ledger.change({ kind: "append",
        subject: { type: "resource", resourceId }, entryKind: "purpose",
        body: "private replacement narwhal", provenance: user,
        visibility: "local_only", supersedesEntryId: first.entry.id,
        idempotencyKey: "resource-private-replacement" });
      if (privateReplacement.kind !== "changed") throw new Error("expected entry");
      expect(ledger.searchShareable({ resourceId, query: "albatross" })).toHaveLength(1);
      expect(JSON.stringify(ledger.readShareable({ type: "resource", resourceId })))
        .not.toContain("narwhal");
      const publicReplacement = ledger.change({ kind: "append",
        subject: { type: "resource", resourceId }, entryKind: "purpose",
        body: "visible current penguin", provenance: agent,
        visibility: "share_with_ai", supersedesEntryId: privateReplacement.entry.id,
        idempotencyKey: "resource-public-replacement" });
      if (publicReplacement.kind !== "changed") throw new Error("expected entry");
      expect(ledger.searchShareable({ resourceId, query: "albatross" })).toHaveLength(1);
      expect(ledger.searchLocal({ resourceId, query: "albatross" })).toHaveLength(0);
      expect(ledger.searchShareable({ resourceId, query: "penguin" })).toHaveLength(1);

      ledger.change({ kind: "review", subject: { type: "resource", resourceId },
        entryId: publicReplacement.entry.id, verdict: "accepted", provenance: user,
        idempotencyKey: "cross-store-review" });
      const pageAgent = ledger.change({ kind: "append",
        subject: { type: "page", logicalPageId: pageId }, entryKind: "purpose",
        body: "page agent", provenance: agent, visibility: "share_with_ai",
        idempotencyKey: "page-agent" });
      if (pageAgent.kind !== "changed") throw new Error("expected entry");
      expect(() => ledger.change({ kind: "review",
        subject: { type: "page", logicalPageId: pageId }, entryId: pageAgent.entry.id,
        verdict: "accepted", provenance: user, idempotencyKey: "cross-store-review" }))
        .toThrowError(expect.objectContaining<Partial<ContextLedgerError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
        }));

      const restarted = createContextLedger(database.connection);
      expect(restarted.readLocal({ type: "resource", resourceId }).currentEntries)
        .toEqual(ledger.readLocal({ type: "resource", resourceId }).currentEntries);
    } finally {
      database.close();
    }
  });

  it("allows exact replay but rejects a new resource-context write after merge", () => {
    const database = openDatabase(":memory:");
    try {
      const commands = createResourceCommandCatalog(database.connection,
        () => new Date("2026-08-12T10:00:00.000Z"));
      const created = commands.change({ kind: "create", resourceKey: "platform:merge-target",
        name: "Merge target", resourceKind: "platform", accessClass: "public",
        provenance: user, idempotencyKey: "create-merge-target" });
      if (created.result.kind !== "create") throw new Error("expected resource");
      const sourceId = Number(database.connection.prepare(
        "SELECT id FROM resources WHERE resource_key = 'platform:youtube'",
      ).pluck().get());
      const ledger = createContextLedger(database.connection);
      const input = { kind: "append" as const,
        subject: { type: "resource" as const, resourceId: sourceId },
        entryKind: "note" as const, body: "before merge", provenance: user,
        visibility: "share_with_ai" as const, idempotencyKey: "before-merge" };
      const receipt = ledger.change(input);
      const rulesetVersion = Number(database.connection.prepare(`
        SELECT events.version FROM resource_ruleset_heads AS heads
        JOIN resource_ruleset_events AS events ON events.id = heads.ruleset_event_id
        WHERE heads.scope = 'global'
      `).pluck().get());
      commands.change({ kind: "merge", sourceResourceId: sourceId,
        targetResourceId: created.result.resource.resource.id,
        expectedSourceVersion: 1, expectedTargetVersion: created.result.resource.version,
        expectedRulesetVersion: rulesetVersion, provenance: user,
        idempotencyKey: "merge-source" });
      expect(ledger.change(input)).toEqual(receipt);
      expect(() => ledger.change({ ...input, body: "after merge",
        idempotencyKey: "after-merge" })).toThrowError(
          expect.objectContaining<Partial<ContextLedgerError>>({ code: "RESOURCE_NOT_ACTIVE" }),
        );
      expect(ledger.readLocal(input.subject).entries).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("runs resource withdraw/restore and rolls entry/review hook faults back across restart", () => {
    const database = openDatabase(":memory:");
    try {
      const resourceId = Number(database.connection.prepare(
        "SELECT id FROM resources WHERE resource_key = 'platform:youtube'",
      ).pluck().get());
      let failEntry = false;
      let failReview = false;
      const ledger = createContextLedger(database.connection, { testHooks: {
        afterEntryInsert() { if (failEntry) throw new Error("resource entry fault"); },
        afterReviewInsert() { if (failReview) throw new Error("resource review fault"); },
      } });
      const subject = { type: "resource", resourceId } as const;
      const first = ledger.change({ kind: "append", subject, entryKind: "note",
        body: "lifecycle", provenance: agent, visibility: "share_with_ai",
        idempotencyKey: "resource-lifecycle-append" });
      if (first.kind !== "changed") throw new Error("expected entry");
      const withdrawn = ledger.change({ kind: "withdraw", subject, entryId: first.entry.id,
        provenance: user, idempotencyKey: "resource-withdraw" });
      if (withdrawn.kind !== "changed") throw new Error("expected entry");
      expect(withdrawn.entry.state).toBe("withdrawn");
      const restored = ledger.change({ kind: "restore", subject, entryId: withdrawn.entry.id,
        provenance: user, idempotencyKey: "resource-restore" });
      if (restored.kind !== "changed") throw new Error("expected entry");
      expect(restored.entry.state).toBe("active");
      failEntry = true;
      expect(() => ledger.change({ kind: "append", subject, entryKind: "note",
        body: "must roll back", provenance: user, visibility: "share_with_ai",
        idempotencyKey: "resource-entry-fault" })).toThrow("resource entry fault");
      failEntry = false;
      failReview = true;
      expect(() => ledger.change({ kind: "review", subject, entryId: first.entry.id,
        verdict: "accepted", provenance: user, idempotencyKey: "resource-review-fault" }))
        .toThrow("resource review fault");
      failReview = false;
      const restarted = createContextLedger(database.connection);
      expect(restarted.readLocal(subject).entries).toHaveLength(3);
      expect(restarted.readLocal(subject).currentEntries).toMatchObject([
        { state: "active", operation: "restore", currentReview: null },
      ]);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_context_entries WHERE idempotency_key = ?
      `).pluck().get("resource-entry-fault")).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_context_entry_reviews WHERE idempotency_key = ?
      `).pluck().get("resource-review-fault")).toBe(0);
    } finally {
      database.close();
    }
  });
});
