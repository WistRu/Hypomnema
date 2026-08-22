import { describe, expect, it } from "vitest";

import { openDatabase, type TabHubDatabase } from "../src/database.js";
import {
  ContextLedgerError,
  createContextLedger,
  type ContextLedger,
  type ContextLedgerTestHooks,
} from "../src/context-ledger.js";

interface ContextFixture {
  database: TabHubDatabase;
  ledger: ContextLedger;
  pageId: number;
  secondPageId: number;
  setNow(value: string): void;
}

function insertLogicalPage(
  database: TabHubDatabase,
  url: string,
  timestamp: string,
): number {
  return Number(
    database.connection
      .prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(url, url, url, timestamp, timestamp).lastInsertRowid,
  );
}

function createFixture(hooks?: ContextLedgerTestHooks): ContextFixture {
  const database = openDatabase(":memory:");
  let currentTime = "2026-08-12T10:00:00.000Z";
  const pageId = insertLogicalPage(database, "https://example.com/one", currentTime);
  const secondPageId = insertLogicalPage(
    database,
    "https://example.com/two",
    currentTime,
  );
  return {
    database,
    ledger: createContextLedger(database.connection, {
      now: () => currentTime,
      ...(hooks === undefined ? {} : { testHooks: hooks }),
    }),
    pageId,
    secondPageId,
    setNow(value) {
      currentTime = value;
    },
  };
}

const user = { actor: "user", method: "manual" } as const;
const agentModel = {
  actor: "agent",
  method: "model",
  sourceFingerprint: "model-input-v1",
  model: { provider: "fixture", name: "test", promptVersion: "v1" },
  confidence: 0.7,
} as const;

function changedEntry(result: ReturnType<ContextLedger["change"]>) {
  if (result.kind !== "changed") throw new Error("Expected changed result");
  return result.entry;
}

describe("ContextLedger", () => {
  it("appends, edits, withdraws, restores, reloads, and selects preview deterministically", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      const nextAction = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "next_action",
          body: "Compare the two implementations",
          provenance: user,
          visibility: "local_only",
          idempotencyKey: "context-append-1",
        }),
      );
      fixture.setNow("2026-08-12T10:01:00.000Z");
      const purpose = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "purpose",
          body: "Background material",
          provenance: user,
          visibility: "share_with_ai",
          idempotencyKey: "context-append-2",
        }),
      );
      expect(fixture.ledger.readLocal(subject).preview).toMatchObject({
        entryId: nextAction.id,
        entryKind: "next_action",
      });

      fixture.setNow("2026-08-12T10:02:00.000Z");
      const edited = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "purpose",
          body: "Updated background material",
          provenance: user,
          visibility: "share_with_ai",
          supersedesEntryId: purpose.id,
          idempotencyKey: "context-edit-1",
        }),
      );
      fixture.setNow("2026-08-12T10:03:00.000Z");
      const withdrawn = changedEntry(
        fixture.ledger.change({
          kind: "withdraw",
          subject,
          entryId: edited.id,
          provenance: user,
          idempotencyKey: "context-withdraw-1",
        }),
      );
      fixture.setNow("2026-08-12T10:04:00.000Z");
      const restored = changedEntry(
        fixture.ledger.change({
          kind: "restore",
          subject,
          entryId: withdrawn.id,
          provenance: user,
          idempotencyKey: "context-restore-1",
        }),
      );

      expect([nextAction, purpose, edited, withdrawn, restored].map((row) => row.revision))
        .toEqual([1, 2, 3, 4, 5]);
      expect(withdrawn).toMatchObject({
        body: "Updated background material",
        state: "withdrawn",
        supersedesId: edited.id,
        withdrawnAt: "2026-08-12T10:03:00.000Z",
      });
      expect(restored).toMatchObject({
        body: "Updated background material",
        state: "active",
        supersedesId: withdrawn.id,
      });
      const reloaded = createContextLedger(fixture.database.connection).readLocal(subject);
      expect(reloaded.entries).toHaveLength(5);
      expect(reloaded.currentEntries.map(({ id }) => id)).toEqual([
        restored.id,
        nextAction.id,
      ]);
      expect(
        fixture.database.connection
          .prepare("SELECT body, actor FROM context_entries WHERE id = ?")
          .get(purpose.id),
      ).toEqual({ body: "Background material", actor: "user" });
    } finally {
      fixture.database.close();
    }
  });

  it("replays identical commands exactly and rejects conflicting key reuse", () => {
    const fixture = createFixture();
    try {
      const command = {
        kind: "append",
        subject: { type: "page", logicalPageId: fixture.pageId },
        entryKind: "note",
        body: "Stable replay",
        provenance: user,
        visibility: "local_only",
        idempotencyKey: "context-replay",
      } as const;
      const first = fixture.ledger.change(command);
      fixture.setNow("2026-08-12T11:00:00.000Z");
      expect(fixture.ledger.change(command)).toEqual(first);
      expect(() =>
        fixture.ledger.change({ ...command, body: "Conflicting payload" }),
      ).toThrowError(
        expect.objectContaining<Partial<ContextLedgerError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
        }),
      );
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entries")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects cross-subject, double supersession, invalid state, and cycle mutation", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      const original = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "note",
          body: "Original",
          provenance: user,
          visibility: "local_only",
          idempotencyKey: "original",
        }),
      );
      expect(() =>
        fixture.ledger.change({
          kind: "append",
          subject: { type: "page", logicalPageId: fixture.secondPageId },
          entryKind: "note",
          body: "Cross subject",
          provenance: user,
          visibility: "local_only",
          supersedesEntryId: original.id,
          idempotencyKey: "cross-subject",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ContextLedgerError>>({
          code: "CONTEXT_SUBJECT_MISMATCH",
        }),
      );
      const successor = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "note",
          body: "Successor",
          provenance: user,
          visibility: "local_only",
          supersedesEntryId: original.id,
          idempotencyKey: "successor",
        }),
      );
      expect(() =>
        fixture.ledger.change({
          kind: "withdraw",
          subject,
          entryId: original.id,
          provenance: user,
          idempotencyKey: "double-supersede",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ContextLedgerError>>({
          code: "CONTEXT_ENTRY_NOT_CURRENT",
        }),
      );
      expect(() =>
        fixture.ledger.change({
          kind: "restore",
          subject,
          entryId: successor.id,
          provenance: user,
          idempotencyKey: "restore-active",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ContextLedgerError>>({
          code: "CONTEXT_STATE_INVALID",
        }),
      );
      expect(() =>
        fixture.database.connection
          .prepare("UPDATE context_entries SET supersedes_id = ? WHERE id = ?")
          .run(successor.id, original.id),
      ).toThrow("context entry history is append-only");
    } finally {
      fixture.database.close();
    }
  });

  it("reviews only agent hypotheses append-only and preserves the original actor/body", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      const agentCommand = {
          kind: "append",
          subject,
          entryKind: "purpose",
          body: "Agent hypothesis text",
          provenance: agentModel,
          visibility: "share_with_ai",
          idempotencyKey: "agent-entry",
        } as const;
      const initialAgentResult = fixture.ledger.change(agentCommand);
      const agentEntry = changedEntry(initialAgentResult);
      const acceptedCommand = {
        kind: "review",
        subject,
        entryId: agentEntry.id,
        verdict: "accepted",
        provenance: user,
        idempotencyKey: "review-accepted",
      } as const;
      const accepted = fixture.ledger.change(acceptedCommand);
      fixture.setNow("2026-08-12T10:01:00.000Z");
      expect(fixture.ledger.change(acceptedCommand)).toEqual(accepted);
      const rejected = fixture.ledger.change({
        ...acceptedCommand,
        verdict: "rejected",
        idempotencyKey: "review-rejected",
      });
      expect(rejected).toMatchObject({
        kind: "reviewed",
        review: { verdict: "rejected" },
      });
      expect(fixture.ledger.change(agentCommand)).toEqual(initialAgentResult);
      const current = fixture.ledger.readLocal(subject).entries[0];
      expect(current).toMatchObject({
        body: "Agent hypothesis text",
        provenance: { actor: "agent", method: "model" },
        currentReview: { verdict: "rejected" },
      });
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entry_reviews")
          .pluck()
          .get(),
      ).toBe(2);

      const userEntry = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "note",
          body: "User statement",
          provenance: user,
          visibility: "local_only",
          idempotencyKey: "user-entry",
        }),
      );
      expect(() =>
        fixture.ledger.change({
          kind: "review",
          subject,
          entryId: userEntry.id,
          verdict: "accepted",
          provenance: user,
          idempotencyKey: "review-user-entry",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ContextLedgerError>>({
          code: "CONTEXT_REVIEW_NOT_ALLOWED",
        }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("keeps private entries non-enumerable in shareable projections", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      const publicEntry = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "purpose",
          body: "Shareable purpose",
          provenance: user,
          visibility: "share_with_ai",
          idempotencyKey: "public-key",
        }),
      );
      const beforePrivateReplacement = fixture.ledger.readShareable(subject);
      fixture.ledger.change({
        kind: "append",
        subject,
        entryKind: "purpose",
        body: "PRIVATE CANARY 5831",
        provenance: user,
        visibility: "local_only",
        supersedesEntryId: publicEntry.id,
        idempotencyKey: "private-key",
      });
      const shareable = fixture.ledger.readShareable(subject);
      expect(shareable).toEqual(beforePrivateReplacement);
      expect(shareable.entries).toHaveLength(1);
      expect(shareable.currentEntries).toHaveLength(1);
      expect(shareable.preview?.body).toBe("Shareable purpose");
      const json = JSON.stringify(shareable);
      expect(json).not.toContain("PRIVATE CANARY 5831");
      expect(json).not.toContain("private-key");
      expect(json).not.toContain("public-key");
      expect(json).not.toMatch(/"(?:id|entryId|revision|supersedesId|idempotencyKey)"/);
    } finally {
      fixture.database.close();
    }
  });

  it("searches only current heads after append/withdraw/restore", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      const original = changedEntry(
        fixture.ledger.change({
          kind: "append",
          subject,
          entryKind: "note",
          body: "narwhal context marker",
          provenance: user,
          visibility: "local_only",
          idempotencyKey: "fts-append",
        }),
      );
      const withdrawn = changedEntry(
        fixture.ledger.change({
          kind: "withdraw",
          subject,
          entryId: original.id,
          provenance: user,
          idempotencyKey: "fts-withdraw",
        }),
      );
      const restored = changedEntry(
        fixture.ledger.change({
          kind: "restore",
          subject,
          entryId: withdrawn.id,
          provenance: user,
          idempotencyKey: "fts-restore",
        }),
      );
      expect(
        fixture.ledger.searchLocal({ query: "narwhal", logicalPageId: fixture.pageId })
          .map(({ operation }) => operation),
      ).toEqual(["restore"]);
      expect(fixture.ledger.readLocal(subject).currentEntries).toMatchObject([
        { id: restored.id, state: "active" },
      ]);
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM contents WHERE text LIKE '%narwhal%'")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      fixture.database.close();
    }
  });

  it("quotes Unicode prefix/AND FTS queries and redacts raw query failures", () => {
    const fixture = createFixture();
    try {
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      fixture.ledger.change({
        kind: "append",
        subject,
        entryKind: "note",
        body: "Приветствие исследователя alpha beta https example com path q broken",
        provenance: user,
        visibility: "share_with_ai",
        idempotencyKey: "safe-fts-all-tokens",
      });
      fixture.ledger.change({
        kind: "append",
        subject,
        entryKind: "note",
        body: "alpha without the second token",
        provenance: user,
        visibility: "share_with_ai",
        idempotencyKey: "safe-fts-alpha-only",
      });

      expect(
        fixture.ledger.searchLocal({ query: "Прив", logicalPageId: fixture.pageId })
          .map(({ body }) => body),
      ).toEqual([
        "Приветствие исследователя alpha beta https example com path q broken",
      ]);
      expect(
        fixture.ledger.searchLocal({ query: "alpha beta", logicalPageId: fixture.pageId })
          .map(({ body }) => body),
      ).toEqual([
        "Приветствие исследователя alpha beta https example com path q broken",
      ]);
      expect(() =>
        fixture.ledger.searchShareable({
          query: 'https://example.com/path?q="broken',
          logicalPageId: fixture.pageId,
        }),
      ).not.toThrow();
      expect(
        fixture.ledger.searchShareable({
          query: 'https://example.com/path?q="broken',
          logicalPageId: fixture.pageId,
        }),
      ).toHaveLength(1);
      expect(
        fixture.ledger.searchLocal({ query: '"', logicalPageId: fixture.pageId }),
      ).toEqual([]);
      expect(
        fixture.ledger.searchLocal({ query: "://?&", logicalPageId: fixture.pageId }),
      ).toEqual([]);

      fixture.database.connection.exec(
        "DROP TABLE context_entries_fts; DROP TABLE shareable_context_entries_fts",
      );
      const queryCanary = 'PRIVATE QUERY CANARY 7219 " https://secret.invalid';
      for (const search of [
        () => fixture.ledger.searchLocal({ query: queryCanary }),
        () => fixture.ledger.searchShareable({ query: queryCanary }),
      ]) {
        let error: unknown;
        try {
          search();
        } catch (caught) {
          error = caught;
        }
        expect(String(error)).toBe("Error: Context search failed");
        expect(String(error)).not.toContain(queryCanary);
        expect(String(error)).not.toContain("secret.invalid");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed without exposing malformed stored provenance or body", () => {
    const fixture = createFixture();
    try {
      const provenanceCanary = "PRIVATE PROVENANCE CANARY 9834";
      const bodyCanary = "PRIVATE BODY CANARY 6148";
      fixture.database.connection.pragma("ignore_check_constraints = ON");
      fixture.database.connection
        .prepare(`
          INSERT INTO context_entries (
            logical_page_id, kind, body, actor, method, visibility, confidence,
            source_fingerprint, model_provenance_json, state, operation,
            revision, idempotency_key, created_at
          ) VALUES (?, 'note', ?, 'agent', 'model', 'local_only', 0.5, ?, ?,
            'active', 'append', 1, 'malformed-context-row', ?)
        `)
        .run(
          fixture.pageId,
          bodyCanary,
          "source-v1",
          JSON.stringify({
            provider: "fixture",
            name: "model",
            promptVersion: "v1",
            forbidden: provenanceCanary,
          }),
          "2026-08-12T10:00:00.000Z",
        );
      fixture.database.connection.pragma("ignore_check_constraints = OFF");

      let error: unknown;
      try {
        fixture.ledger.readLocal({
          type: "page",
          logicalPageId: fixture.pageId,
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toBe(
        "Error: Stored context provenance violates schema invariants",
      );
      expect(String(error)).not.toContain(bodyCanary);
      expect(String(error)).not.toContain(provenanceCanary);
    } finally {
      fixture.database.close();
    }
  });

  it("survives deletion of every physical browser copy while logical identity remains", () => {
    const fixture = createFixture();
    try {
      fixture.database.connection
        .prepare(`
          INSERT INTO tabs (
            url, url_normalized, title, browser, first_seen_at, last_seen_at,
            logical_page_id
          ) VALUES (?, ?, ?, 'chrome', ?, ?, ?)
        `)
        .run(
          "https://example.com/one",
          "https://example.com/one",
          "One",
          "2026-08-12T10:00:00.000Z",
          "2026-08-12T10:00:00.000Z",
          fixture.pageId,
        );
      const subject = { type: "page", logicalPageId: fixture.pageId } as const;
      fixture.ledger.change({
        kind: "append",
        subject,
        entryKind: "note",
        body: "Durable without tabs",
        provenance: user,
        visibility: "local_only",
        idempotencyKey: "durable-entry",
      });
      fixture.database.connection
        .prepare("DELETE FROM tabs WHERE logical_page_id = ?")
        .run(fixture.pageId);
      expect(fixture.ledger.readLocal(subject).currentEntries).toMatchObject([
        { body: "Durable without tabs" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("rolls back an injected failure after inserting a revision", () => {
    let fail = true;
    const fixture = createFixture({
      afterEntryInsert() {
        if (fail) throw new Error("injected context rollback");
      },
    });
    try {
      const command = {
        kind: "append",
        subject: { type: "page", logicalPageId: fixture.pageId },
        entryKind: "note",
        body: "Rollback body",
        provenance: user,
        visibility: "local_only",
        idempotencyKey: "rollback-entry",
      } as const;
      expect(() => fixture.ledger.change(command)).toThrow(
        "injected context rollback",
      );
      expect(fixture.ledger.readLocal(command.subject).entries).toEqual([]);
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entries_fts")
          .pluck()
          .get(),
      ).toBe(0);
      fail = false;
      expect(fixture.ledger.change(command).kind).toBe("changed");
    } finally {
      fixture.database.close();
    }
  });
});
