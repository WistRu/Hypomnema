import { describe, expect, it } from "vitest";

import type { ExactTabScope, ExpectedTabPage } from "@tabhub/shared";

import { createContextLedger } from "../src/context-ledger.js";
import { openDatabase, type TabHubDatabase } from "../src/database.js";
import {
  createSessionIntentLedger,
  createSessionIntentReconciler,
  SessionIntentLedgerError,
  type SessionIntentLedger,
  type SessionIntentLedgerTestHooks,
} from "../src/session-intent-ledger.js";
import { createTabInstanceCatalog } from "../src/tab-instance-catalog.js";

const scope: ExactTabScope = {
  installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  browserSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  browserTabId: 7,
};

const user = { actor: "user", method: "manual" } as const;

interface SessionFixture {
  database: TabHubDatabase;
  ledger: SessionIntentLedger;
  pageId: number;
  secondPageId: number;
  expectedPage(): ExpectedTabPage;
  navigate(url: string, observedAt: string): void;
  setNow(value: string): void;
}

function insertPageAndTab(
  database: TabHubDatabase,
  id: number,
  url: string,
  timestamp: string,
): number {
  const pageId = Number(
    database.connection
      .prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(url, url, url, timestamp, timestamp).lastInsertRowid,
  );
  database.connection
    .prepare(`
      INSERT INTO tabs (
        id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
        logical_page_id
      ) VALUES (?, ?, ?, ?, 'chrome', ?, ?, ?)
    `)
    .run(id, url, url, `Page ${id}`, timestamp, timestamp, pageId);
  return pageId;
}

function createFixture(hooks?: SessionIntentLedgerTestHooks): SessionFixture {
  const database = openDatabase(":memory:");
  let currentTime = "2026-08-12T10:00:00.000Z";
  const pageId = insertPageAndTab(
    database,
    101,
    "https://example.com/one",
    currentTime,
  );
  const secondPageId = insertPageAndTab(
    database,
    102,
    "https://example.com/two",
    currentTime,
  );
  const instances = createTabInstanceCatalog(database.connection, {
    sessionIntentReconciler: createSessionIntentReconciler(database.connection),
  });
  const sync = (url: string, observedAt: string) => {
    instances.syncSnapshot(
      {
        browser: "chrome",
        installationId: scope.installationId,
        browserSessionId: scope.browserSessionId,
        tabs: [{ tabId: scope.browserTabId, url, windowId: 1, index: 0 }],
      },
      observedAt,
    );
  };
  sync("https://example.com/one", currentTime);
  const context = createContextLedger(database.connection, {
    now: () => currentTime,
  });
  const ledger = createSessionIntentLedger(database.connection, context, {
    now: () => currentTime,
    ...(hooks === undefined ? {} : { testHooks: hooks }),
  });
  return {
    database,
    ledger,
    pageId,
    secondPageId,
    expectedPage() {
      const row = database.connection
        .prepare(`
          SELECT tabs.logical_page_id, tab_instances.url, tabs.url_normalized,
                 tab_instances.navigation_revision
          FROM tab_instances
          JOIN tabs ON tabs.id = tab_instances.tab_id
          WHERE tab_instances.installation_id = ?
            AND tab_instances.browser_session_id = ?
            AND tab_instances.browser_tab_id = ?
        `)
        .get(
          scope.installationId,
          scope.browserSessionId,
          scope.browserTabId,
        ) as {
          logical_page_id: number;
          url: string;
          url_normalized: string;
          navigation_revision: number;
        };
      return {
        logicalPageId: row.logical_page_id,
        url: row.url,
        urlNormalized: row.url_normalized,
        instanceRevision: row.navigation_revision,
      };
    },
    navigate: sync,
    setNow(value) {
      currentTime = value;
    },
  };
}

function setCommand(fixture: SessionFixture, overrides: Record<string, unknown> = {}) {
  return {
    kind: "set" as const,
    scope,
    expectedPage: fixture.expectedPage(),
    body: "Why this tab is open",
    provenance: user,
    visibility: "local_only" as const,
    idempotencyKey: "intent-set-1",
    ...overrides,
  };
}

describe("SessionIntentLedger", () => {
  it("persists exact-scope intent across ledger reload and ordinary snapshot refresh", () => {
    const fixture = createFixture();
    try {
      const firstExpected = fixture.expectedPage();
      expect(firstExpected.instanceRevision).toBe(1);
      const result = fixture.ledger.change(setCommand(fixture));
      expect(result).toMatchObject({ kind: "set", intent: { state: "active" } });

      fixture.navigate("https://example.com/one", "2026-08-12T10:05:00.000Z");
      expect(fixture.expectedPage().instanceRevision).toBe(1);
      const reloaded = createSessionIntentLedger(
        fixture.database.connection,
        createContextLedger(fixture.database.connection),
      );
      expect(reloaded.readLocal(scope).current).toMatchObject({
        body: "Why this tab is open",
        expectedPage: firstExpected,
      });
      expect(reloaded.listLocal({ page: 1, pageSize: 20 })).toMatchObject({
        total: 1,
        items: [{ state: "active" }],
      });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects stale writes and archives the old intent when the exact tab navigates", () => {
    const fixture = createFixture();
    try {
      const staleExpected = fixture.expectedPage();
      const first = fixture.ledger.change(setCommand(fixture));
      if (first.kind !== "set") throw new Error("Expected set");
      fixture.setNow("2026-08-12T10:06:00.000Z");
      fixture.navigate("https://example.com/two", "2026-08-12T10:06:00.000Z");
      expect(fixture.expectedPage()).toMatchObject({
        logicalPageId: fixture.secondPageId,
        instanceRevision: 2,
      });
      expect(fixture.ledger.readLocal(scope)).toMatchObject({
        current: null,
        history: [{
          id: first.intent.id,
          state: "archived",
          archivedAt: "2026-08-12T10:06:00.000Z",
          expiresAt: "2026-09-11T10:06:00.000Z",
        }],
      });
      expect(() =>
        fixture.ledger.change({
          ...setCommand(fixture),
          expectedPage: staleExpected,
          idempotencyKey: "stale-navigation-write",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<SessionIntentLedgerError>>({
          code: "SESSION_SCOPE_STALE",
        }),
      );

      const second = fixture.ledger.change(
        setCommand(fixture, {
          body: "Intent for navigated page",
          idempotencyKey: "intent-set-2",
        }),
      );
      expect(second).toMatchObject({
        kind: "set",
        intent: {
          subject: { logicalPageId: fixture.secondPageId },
          expectedPage: { instanceRevision: 2 },
          state: "active",
        },
      });
      const history = fixture.ledger.readLocal(scope).history;
      expect(history.map(({ state }) => state)).toEqual(["active", "archived"]);
      expect(history[1]).toMatchObject({
        id: first.intent.id,
        archivedAt: "2026-08-12T10:06:00.000Z",
        expiresAt: "2026-09-11T10:06:00.000Z",
      });
      expect(
        fixture.database.connection
          .prepare(`
            SELECT COUNT(*) FROM tab_session_intents
            WHERE installation_id = ? AND browser_session_id = ?
              AND browser_tab_id = ? AND state = 'active'
          `)
          .pluck()
          .get(scope.installationId, scope.browserSessionId, scope.browserTabId),
      ).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("replays set exactly before lifecycle changes and rejects conflicting key reuse", () => {
    const fixture = createFixture();
    try {
      const command = setCommand(fixture);
      const first = fixture.ledger.change(command);
      fixture.setNow("2026-08-12T11:00:00.000Z");
      expect(fixture.ledger.change(command)).toEqual(first);
      expect(() =>
        fixture.ledger.change({ ...command, body: "Conflicting body" }),
      ).toThrowError(
        expect.objectContaining<Partial<SessionIntentLedgerError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
        }),
      );
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM tab_session_intents")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  it("archives with immutable 30-day expiry, expires at the boundary, and purges safely", () => {
    const fixture = createFixture();
    try {
      const set = fixture.ledger.change(setCommand(fixture));
      if (set.kind !== "set") throw new Error("Expected set");
      fixture.setNow("2026-08-12T12:00:00.000Z");
      const archived = fixture.ledger.change({
        kind: "archive",
        intentId: set.intent.id,
        idempotencyKey: "intent-archive-1",
      });
      expect(archived).toMatchObject({
        kind: "archived",
        intent: {
          archivedAt: "2026-08-12T12:00:00.000Z",
          expiresAt: "2026-09-11T12:00:00.000Z",
        },
      });
      expect(fixture.ledger.change(setCommand(fixture))).toEqual(set);
      expect(
        fixture.ledger.change({
          kind: "expire_due",
          now: "2026-09-11T11:59:59.999Z",
        }),
      ).toEqual({ kind: "expired", intentIds: [] });
      expect(
        fixture.ledger.change({
          kind: "expire_due",
          now: "2026-09-11T12:00:00.000Z",
        }),
      ).toEqual({ kind: "expired", intentIds: [set.intent.id] });
      expect(
        fixture.database.connection
          .prepare("SELECT archived_at, expires_at FROM tab_session_intents")
          .get(),
      ).toEqual({
        archived_at: "2026-08-12T12:00:00.000Z",
        expires_at: "2026-09-11T12:00:00.000Z",
      });
      expect(() =>
        fixture.database.connection
          .prepare("UPDATE tab_session_intents SET expires_at = ? WHERE id = ?")
          .run("2026-09-12T12:00:00.000Z", set.intent.id),
      ).toThrow("archived intent expiry is immutable");
      expect(() =>
        fixture.database.connection
          .prepare("UPDATE tab_session_intents SET archive_cause = 'navigation' WHERE id = ?")
          .run(set.intent.id),
      ).toThrow("archived intent expiry is immutable");
      expect(
        fixture.ledger.purgeExpired({ before: "2026-09-11T12:00:00.000Z" }),
      ).toEqual({ purged: 1 });
      expect(
        fixture.ledger.purgeExpired({ before: "2026-09-11T12:00:00.000Z" }),
      ).toEqual({ purged: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("promotes once atomically, replays exactly, and rejects another page", () => {
    const fixture = createFixture();
    try {
      const set = fixture.ledger.change(
        setCommand(fixture, {
          visibility: "share_with_ai",
          idempotencyKey: "intent-promote-source",
        }),
      );
      if (set.kind !== "set") throw new Error("Expected set");
      const command = {
        kind: "promote",
        intentId: set.intent.id,
        subject: { type: "page", logicalPageId: fixture.pageId },
        contextKind: "next_action",
        idempotencyKey: "intent-promote-1",
      } as const;
      const promoted = fixture.ledger.change(command);
      expect(promoted).toMatchObject({
        kind: "promoted",
        intent: { state: "promoted" },
        context: {
          body: "Why this tab is open",
          entryKind: "next_action",
          visibility: "share_with_ai",
        },
      });
      fixture.setNow("2026-08-12T13:00:00.000Z");
      expect(fixture.ledger.change(command)).toEqual(promoted);
      expect(
        fixture.ledger.change(
          setCommand(fixture, {
            visibility: "share_with_ai",
            idempotencyKey: "intent-promote-source",
          }),
        ),
      ).toEqual(set);
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entries")
          .pluck()
          .get(),
      ).toBe(1);
      expect(() =>
        fixture.ledger.change({
          ...command,
          idempotencyKey: "intent-promote-wrong-page",
          subject: { type: "page", logicalPageId: fixture.secondPageId },
        }),
      ).toThrowError(
        expect.objectContaining<Partial<SessionIntentLedgerError>>({
          code: "SESSION_INTENT_SUBJECT_MISMATCH",
        }),
      );
      expect(fixture.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("rolls back context creation when promotion fails before linking the intent", () => {
    let fail = true;
    const fixture = createFixture({
      afterContextPromotion() {
        if (fail) throw new Error("injected promote rollback");
      },
    });
    try {
      const set = fixture.ledger.change(setCommand(fixture));
      if (set.kind !== "set") throw new Error("Expected set");
      const command = {
        kind: "promote",
        intentId: set.intent.id,
        subject: { type: "page", logicalPageId: fixture.pageId },
        contextKind: "note",
        idempotencyKey: "promote-rollback",
      } as const;
      expect(() => fixture.ledger.change(command)).toThrow(
        "injected promote rollback",
      );
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entries")
          .pluck()
          .get(),
      ).toBe(0);
      expect(fixture.ledger.readLocal(scope).current?.state).toBe("active");
      fail = false;
      expect(fixture.ledger.change(command).kind).toBe("promoted");
    } finally {
      fixture.database.close();
    }
  });

  it("does not expose private intent existence, identifiers, lineage, or keys", () => {
    const fixture = createFixture();
    try {
      fixture.ledger.change(
        setCommand(fixture, {
          body: "Shareable session reason",
          visibility: "share_with_ai",
          idempotencyKey: "shareable-intent-key",
        }),
      );
      const before = fixture.ledger.readShareable(scope);
      fixture.setNow("2026-08-12T10:01:00.000Z");
      fixture.ledger.change(
        setCommand(fixture, {
          body: "PRIVATE INTENT CANARY 9142",
          visibility: "local_only",
          idempotencyKey: "private-intent-key",
        }),
      );
      const shareable = fixture.ledger.readShareable(scope);
      expect(shareable).toEqual(before);
      const json = JSON.stringify(shareable);
      expect(json).not.toContain("PRIVATE INTENT CANARY 9142");
      expect(json).not.toContain("private-intent-key");
      expect(json).not.toContain("shareable-intent-key");
      expect(json).not.toMatch(
        /"(?:id|intentId|idempotencyKey|archivedAt|expiresAt|promotedContextEntryId)"/,
      );

      fixture.setNow("2026-08-12T10:02:00.000Z");
      fixture.navigate("https://example.com/two", "2026-08-12T10:02:00.000Z");
      expect(fixture.ledger.readShareable(scope)).toMatchObject({
        current: null,
        history: [{ body: "Shareable session reason", state: "archived" }],
      });
    } finally {
      fixture.database.close();
    }
  });

  it("projects public-private-public exactly like the public-only control", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible P",
            visibility: "share_with_ai",
            idempotencyKey: `visible-p-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE HIDDEN X 5107",
          visibility: "local_only",
          idempotencyKey: "hidden-x",
        }),
      );
      for (const fixture of [control, hidden]) {
        fixture.setNow("2026-08-12T10:02:00.000Z");
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible Q",
            visibility: "share_with_ai",
            idempotencyKey: `visible-q-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }

      const controlJson = JSON.stringify(control.ledger.readShareable(scope));
      const hiddenJson = JSON.stringify(hidden.ledger.readShareable(scope));
      expect(hiddenJson).toBe(controlJson);
      expect(hiddenJson).not.toContain("PRIVATE HIDDEN X 5107");
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("projects deep hidden replacement chains and navigation like a public-only control", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible deep P",
            visibility: "share_with_ai",
            idempotencyKey: `deep-p-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE DEEP X 8140",
          visibility: "local_only",
          idempotencyKey: "deep-hidden-x",
        }),
      );
      hidden.setNow("2026-08-12T10:02:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE DEEP Y 2276",
          visibility: "local_only",
          idempotencyKey: "deep-hidden-y",
        }),
      );
      for (const fixture of [control, hidden]) {
        fixture.setNow("2026-08-12T10:03:00.000Z");
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible deep Q",
            visibility: "share_with_ai",
            idempotencyKey: `deep-q-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(
        JSON.stringify(control.ledger.readShareable(scope)),
      );

      for (const fixture of [control, hidden]) {
        fixture.setNow("2026-08-12T10:04:00.000Z");
        fixture.navigate("https://example.com/two", "2026-08-12T10:04:00.000Z");
      }
      const controlJson = JSON.stringify(control.ledger.readShareable(scope));
      const hiddenJson = JSON.stringify(hidden.ledger.readShareable(scope));
      expect(hiddenJson).toBe(controlJson);
      expect(hiddenJson).not.toContain("PRIVATE DEEP X 8140");
      expect(hiddenJson).not.toContain("PRIVATE DEEP Y 2276");
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("keeps active hidden replacement chains invisible across their stored expiry", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible retained P",
            visibility: "share_with_ai",
            idempotencyKey: `retained-p-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE RETAINED X 4021",
          visibility: "local_only",
          idempotencyKey: "retained-hidden-x",
        }),
      );
      hidden.setNow("2026-08-12T10:02:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE RETAINED Y 9027",
          visibility: "local_only",
          idempotencyKey: "retained-hidden-y",
        }),
      );
      const before = JSON.stringify(control.ledger.readShareable(scope));
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(before);

      const boundary = "2026-09-11T10:02:00.000Z";
      expect(control.ledger.change({ kind: "expire_due", now: boundary })).toEqual({
        kind: "expired",
        intentIds: [],
      });
      expect(hidden.ledger.change({ kind: "expire_due", now: boundary })).toMatchObject({
        kind: "expired",
        intentIds: [expect.any(Number)],
      });
      expect(hidden.ledger.purgeExpired({ before: boundary })).toEqual({ purged: 1 });
      expect(JSON.stringify(control.ledger.readShareable(scope))).toBe(before);
      const after = JSON.stringify(hidden.ledger.readShareable(scope));
      expect(after).toBe(before);
      expect(after).not.toContain("PRIVATE RETAINED X 4021");
      expect(after).not.toContain("PRIVATE RETAINED Y 9027");
      expect(
        hidden.database.connection
          .prepare("SELECT COUNT(*) FROM tab_session_intents")
          .pluck()
          .get(),
      ).toBe(2);
      expect(hidden.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("rejects direct revival after a private navigation terminal", () => {
    const fixture = createFixture();
    try {
      fixture.ledger.change(setCommand(fixture, {
        body: "Visible revival guard",
        visibility: "share_with_ai",
        idempotencyKey: "revival-guard-public",
      }));
      fixture.setNow("2026-08-12T10:01:00.000Z");
      fixture.ledger.change(setCommand(fixture, {
        body: "PRIVATE REVIVAL GUARD 9912",
        visibility: "local_only",
        idempotencyKey: "revival-guard-private",
      }));
      fixture.setNow("2026-08-12T10:02:00.000Z");
      fixture.navigate("https://example.com/two", "2026-08-12T10:02:00.000Z");
      fixture.ledger.change({
        kind: "expire_due",
        now: "2026-09-11T10:02:00.000Z",
      });
      expect(() =>
        fixture.database.connection
          .prepare(`
            UPDATE tab_session_intents
            SET state = 'active', archive_idempotency_key = NULL,
                archive_cause = NULL, replacement_idempotency_key = NULL,
                archived_at = NULL, expires_at = NULL, updated_at = created_at
            WHERE idempotency_key = 'revival-guard-public'
          `)
          .run(),
      ).toThrow("archived intent expiry is immutable");
    } finally {
      fixture.database.close();
    }
  });

  it("expires and purges deep hidden navigation chains like the public-only control", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible navigation P",
            visibility: "share_with_ai",
            idempotencyKey: `navigation-p-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE NAVIGATION X 3782",
          visibility: "local_only",
          idempotencyKey: "navigation-hidden-x",
        }),
      );
      hidden.setNow("2026-08-12T10:02:00.000Z");
      hidden.ledger.change(
        setCommand(hidden, {
          body: "PRIVATE NAVIGATION Y 6814",
          visibility: "local_only",
          idempotencyKey: "navigation-hidden-y",
        }),
      );
      for (const fixture of [control, hidden]) {
        fixture.setNow("2026-08-12T10:03:00.000Z");
        fixture.navigate("https://example.com/two", "2026-08-12T10:03:00.000Z");
      }
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(
        JSON.stringify(control.ledger.readShareable(scope)),
      );

      const tooEarly = "2026-09-11T10:02:59.999Z";
      control.ledger.change({ kind: "expire_due", now: tooEarly });
      hidden.ledger.change({ kind: "expire_due", now: tooEarly });
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(
        JSON.stringify(control.ledger.readShareable(scope)),
      );
      const boundary = "2026-09-11T10:03:00.000Z";
      expect(control.ledger.change({ kind: "expire_due", now: boundary })).toMatchObject({
        kind: "expired",
        intentIds: [expect.any(Number)],
      });
      expect(hidden.ledger.change({ kind: "expire_due", now: boundary })).toMatchObject({
        kind: "expired",
        intentIds: [expect.any(Number), expect.any(Number)],
      });
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(
        JSON.stringify(control.ledger.readShareable(scope)),
      );
      expect(control.ledger.purgeExpired({ before: boundary })).toEqual({ purged: 1 });
      expect(hidden.ledger.purgeExpired({ before: boundary })).toEqual({ purged: 3 });
      expect(hidden.ledger.readShareable(scope)).toEqual(
        control.ledger.readShareable(scope),
      );
      expect(hidden.ledger.readShareable(scope).history).toEqual([]);
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("expires and purges hidden chains before a public successor at its visible time", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Visible expiry P",
            visibility: "share_with_ai",
            idempotencyKey: `expiry-p-${fixture === control ? "control" : "hidden"}`,
          }),
        );
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(setCommand(hidden, {
        body: "PRIVATE EXPIRY X 1993",
        visibility: "local_only",
        idempotencyKey: "expiry-hidden-x",
      }));
      hidden.setNow("2026-08-12T10:02:00.000Z");
      hidden.ledger.change(setCommand(hidden, {
        body: "PRIVATE EXPIRY Y 7331",
        visibility: "local_only",
        idempotencyKey: "expiry-hidden-y",
      }));
      for (const fixture of [control, hidden]) {
        fixture.setNow("2026-08-12T10:03:00.000Z");
        fixture.ledger.change(setCommand(fixture, {
          body: "Visible expiry Q",
          visibility: "share_with_ai",
          idempotencyKey: `expiry-q-${fixture === control ? "control" : "hidden"}`,
        }));
      }
      const boundary = "2026-09-11T10:03:00.000Z";
      control.ledger.change({ kind: "expire_due", now: boundary });
      hidden.ledger.change({ kind: "expire_due", now: boundary });
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(
        JSON.stringify(control.ledger.readShareable(scope)),
      );
      expect(control.ledger.purgeExpired({ before: boundary })).toEqual({ purged: 1 });
      expect(hidden.ledger.purgeExpired({ before: boundary })).toEqual({ purged: 3 });
      const controlJson = JSON.stringify(control.ledger.readShareable(scope));
      const hiddenJson = JSON.stringify(hidden.ledger.readShareable(scope));
      expect(hiddenJson).toBe(controlJson);
      expect(hiddenJson).not.toContain("PRIVATE EXPIRY X 1993");
      expect(hiddenJson).not.toContain("PRIVATE EXPIRY Y 7331");
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("compacts and purges a deep explicit hidden chain without changing public bytes", () => {
    const control = createFixture();
    const hidden = createFixture();
    try {
      for (const fixture of [control, hidden]) {
        fixture.ledger.change(setCommand(fixture, {
          body: "Visible explicit P",
          visibility: "share_with_ai",
          idempotencyKey: `explicit-p-${fixture === control ? "control" : "hidden"}`,
        }));
      }
      hidden.setNow("2026-08-12T10:01:00.000Z");
      hidden.ledger.change(setCommand(hidden, {
        body: "PRIVATE EXPLICIT X 2448",
        visibility: "local_only",
        idempotencyKey: "explicit-hidden-x",
      }));
      hidden.setNow("2026-08-12T10:02:00.000Z");
      hidden.ledger.change(setCommand(hidden, {
        body: "PRIVATE EXPLICIT Y 7556",
        visibility: "local_only",
        idempotencyKey: "explicit-hidden-y",
      }));
      const terminal = hidden.ledger.readLocal(scope).current;
      if (terminal === null) throw new Error("Expected hidden terminal");
      hidden.setNow("2026-08-12T10:03:00.000Z");
      hidden.ledger.change({
        kind: "archive",
        intentId: terminal.id,
        idempotencyKey: "explicit-hidden-archive",
      });
      const controlJson = JSON.stringify(control.ledger.readShareable(scope));
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(controlJson);

      const firstBoundary = "2026-09-11T10:02:00.000Z";
      hidden.ledger.change({ kind: "expire_due", now: firstBoundary });
      expect(hidden.ledger.purgeExpired({ before: firstBoundary })).toEqual({
        purged: 1,
      });
      expect(JSON.stringify(hidden.ledger.readShareable(scope))).toBe(controlJson);
      expect(
        hidden.database.connection
          .prepare("SELECT COUNT(*) FROM tab_session_intents")
          .pluck()
          .get(),
      ).toBe(2);
      expect(hidden.database.connection.pragma("foreign_key_check")).toEqual([]);

      const terminalBoundary = "2026-09-11T10:03:00.000Z";
      hidden.ledger.change({ kind: "expire_due", now: terminalBoundary });
      expect(hidden.ledger.purgeExpired({ before: terminalBoundary })).toEqual({
        purged: 1,
      });
      const after = JSON.stringify(hidden.ledger.readShareable(scope));
      expect(after).toBe(controlJson);
      expect(after).not.toContain("PRIVATE EXPLICIT X 2448");
      expect(after).not.toContain("PRIVATE EXPLICIT Y 7556");
      expect(
        hidden.database.connection
          .prepare(`
            SELECT state, archive_idempotency_key, archive_cause,
                   replacement_idempotency_key, archived_at, expires_at,
                   updated_at, created_at
            FROM tab_session_intents
          `)
          .get(),
      ).toMatchObject({
        state: "active",
        archive_idempotency_key: null,
        archive_cause: null,
        replacement_idempotency_key: null,
        archived_at: null,
        expires_at: null,
        updated_at: "2026-08-12T10:00:00.000Z",
        created_at: "2026-08-12T10:00:00.000Z",
      });
      expect(hidden.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      control.database.close();
      hidden.database.close();
    }
  });

  it("clears replacement lineage on promotion so an expired private target can purge", () => {
    const fixture = createFixture();
    try {
      const publicResult = fixture.ledger.change(
        setCommand(fixture, {
          body: "Public reason to promote",
          visibility: "share_with_ai",
          idempotencyKey: "purge-edge-public",
        }),
      );
      if (publicResult.kind !== "set") throw new Error("Expected set");
      fixture.setNow("2026-08-12T10:01:00.000Z");
      const privateResult = fixture.ledger.change(
        setCommand(fixture, {
          body: "PRIVATE PURGE TARGET CANARY 3187",
          visibility: "local_only",
          idempotencyKey: "purge-edge-private",
        }),
      );
      if (privateResult.kind !== "set") throw new Error("Expected set");

      fixture.setNow("2026-08-12T10:02:00.000Z");
      const promoted = fixture.ledger.change({
        kind: "promote",
        intentId: publicResult.intent.id,
        subject: { type: "page", logicalPageId: fixture.pageId },
        contextKind: "note",
        idempotencyKey: "purge-edge-promote",
      });
      expect(promoted).toMatchObject({
        kind: "promoted",
        intent: { id: publicResult.intent.id, state: "promoted" },
        context: { body: "Public reason to promote" },
      });
      expect(
        fixture.database.connection
          .prepare(`
            SELECT state, replacement_idempotency_key, promoted_context_entry_id
            FROM tab_session_intents WHERE id = ?
          `)
          .get(publicResult.intent.id),
      ).toMatchObject({
        state: "promoted",
        replacement_idempotency_key: null,
        promoted_context_entry_id: promoted.kind === "promoted"
          ? promoted.context.id
          : -1,
      });

      fixture.setNow("2026-08-12T10:03:00.000Z");
      fixture.ledger.change({
        kind: "archive",
        intentId: privateResult.intent.id,
        idempotencyKey: "purge-edge-archive-private",
      });
      expect(
        fixture.ledger.change({
          kind: "expire_due",
          now: "2026-09-11T10:03:00.000Z",
        }),
      ).toEqual({ kind: "expired", intentIds: [privateResult.intent.id] });
      expect(
        fixture.ledger.purgeExpired({ before: "2026-09-11T10:03:00.000Z" }),
      ).toEqual({ purged: 1 });
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM tab_session_intents WHERE id = ?")
          .pluck()
          .get(privateResult.intent.id),
      ).toBe(0);
      expect(fixture.ledger.readLocal(scope).history).toMatchObject([
        {
          id: publicResult.intent.id,
          state: "promoted",
          promotedContextEntryId: promoted.kind === "promoted"
            ? promoted.context.id
            : null,
        },
      ]);
      expect(
        fixture.database.connection
          .prepare("SELECT COUNT(*) FROM context_entries WHERE id = ?")
          .pluck()
          .get(promoted.kind === "promoted" ? promoted.context.id : -1),
      ).toBe(1);
      expect(fixture.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("reconciles disappearance through snapshot and direct-delete seams", () => {
    const fixture = createFixture();
    try {
      const first = fixture.ledger.change(setCommand(fixture));
      if (first.kind !== "set") throw new Error("Expected set");
      fixture.setNow("2026-08-12T10:10:00.000Z");
      createTabInstanceCatalog(fixture.database.connection, {
        sessionIntentReconciler: createSessionIntentReconciler(
          fixture.database.connection,
        ),
      }).syncSnapshot(
        {
          browser: "chrome",
          installationId: scope.installationId,
          browserSessionId: scope.browserSessionId,
          tabs: [],
        },
        "2026-08-12T10:10:00.000Z",
      );
      expect(fixture.ledger.readLocal(scope).history[0]).toMatchObject({
        state: "archived",
        archivedAt: "2026-08-12T10:10:00.000Z",
        expiresAt: "2026-09-11T10:10:00.000Z",
      });
      expect(
        fixture.ledger.change({
          kind: "expire_due",
          now: "2026-09-11T10:10:00.000Z",
        }),
      ).toEqual({ kind: "expired", intentIds: [first.intent.id] });

      fixture.navigate("https://example.com/one", "2026-08-12T10:11:00.000Z");
      const second = fixture.ledger.change(
        setCommand(fixture, { idempotencyKey: "direct-delete-intent" }),
      );
      if (second.kind !== "set") throw new Error("Expected set");
      fixture.database.connection
        .prepare(`
          DELETE FROM tab_instances
          WHERE installation_id = ? AND browser_session_id = ? AND browser_tab_id = ?
        `)
        .run(scope.installationId, scope.browserSessionId, scope.browserTabId);
      expect(
        fixture.ledger.reconcilePhysicalScopes({
          at: "2026-08-12T10:12:00.000Z",
        }),
      ).toEqual({ archived: 1 });
      expect(fixture.ledger.readLocal(scope).history[0]).toMatchObject({
        id: second.intent.id,
        state: "archived",
        archivedAt: "2026-08-12T10:12:00.000Z",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("leaves stored intents untouched when snapshot sync has no reconciler", () => {
    const fixture = createFixture();
    try {
      const first = fixture.ledger.change(setCommand(fixture));
      if (first.kind !== "set") throw new Error("Expected set");
      createTabInstanceCatalog(fixture.database.connection).syncSnapshot(
        {
          browser: "chrome",
          installationId: scope.installationId,
          browserSessionId: scope.browserSessionId,
          tabs: [],
        },
        "2026-08-12T10:20:00.000Z",
      );
      expect(
        fixture.database.connection
          .prepare(`
            SELECT state, archived_at, expires_at, archive_cause
            FROM tab_session_intents WHERE id = ?
          `)
          .get(first.intent.id),
      ).toEqual({
        state: "active",
        archived_at: null,
        expires_at: null,
        archive_cause: null,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("rolls back snapshot navigation and intent reconciliation together", () => {
    const fixture = createFixture();
    try {
      const intent = fixture.ledger.change(setCommand(fixture));
      if (intent.kind !== "set") throw new Error("Expected set");
      const instanceBefore = fixture.database.connection
        .prepare(`
          SELECT tab_id, url, navigation_revision, last_seen_at
          FROM tab_instances
          WHERE installation_id = ? AND browser_session_id = ?
            AND browser_tab_id = ?
        `)
        .get(scope.installationId, scope.browserSessionId, scope.browserTabId);
      const intentBefore = fixture.database.connection
        .prepare(`
          SELECT state, archive_idempotency_key, archive_cause,
                 replacement_idempotency_key, archived_at, expires_at, updated_at
          FROM tab_session_intents WHERE id = ?
        `)
        .get(intent.intent.id);
      const realReconciler = createSessionIntentReconciler(
        fixture.database.connection,
      );
      const failingCatalog = createTabInstanceCatalog(fixture.database.connection, {
        sessionIntentReconciler: {
          reconcilePhysicalScopes(input) {
            realReconciler.reconcilePhysicalScopes(input);
            throw new Error("injected reconciler rollback");
          },
        },
      });

      expect(() =>
        failingCatalog.syncSnapshot(
          {
            browser: "chrome",
            installationId: scope.installationId,
            browserSessionId: scope.browserSessionId,
            tabs: [{
              tabId: scope.browserTabId,
              url: "https://example.com/two",
              windowId: 1,
              index: 0,
            }],
          },
          "2026-08-12T10:30:00.000Z",
        ),
      ).toThrow("injected reconciler rollback");
      expect(
        fixture.database.connection
          .prepare(`
            SELECT tab_id, url, navigation_revision, last_seen_at
            FROM tab_instances
            WHERE installation_id = ? AND browser_session_id = ?
              AND browser_tab_id = ?
          `)
          .get(scope.installationId, scope.browserSessionId, scope.browserTabId),
      ).toEqual(instanceBefore);
      expect(
        fixture.database.connection
          .prepare(`
            SELECT state, archive_idempotency_key, archive_cause,
                   replacement_idempotency_key, archived_at, expires_at, updated_at
            FROM tab_session_intents WHERE id = ?
          `)
          .get(intent.intent.id),
      ).toEqual(intentBefore);
      expect(fixture.ledger.readLocal(scope).current?.id).toBe(intent.intent.id);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects broken and cyclic replacement chains at the database boundary", () => {
    const fixture = createFixture();
    try {
      const first = fixture.ledger.change(setCommand(fixture));
      if (first.kind !== "set") throw new Error("Expected set");
      expect(() =>
        fixture.database.connection.transaction(() => {
          fixture.database.connection
            .prepare(`
              UPDATE tab_session_intents
              SET state = 'archived', archive_idempotency_key = 'broken-archive',
                  archive_cause = 'replacement',
                  replacement_idempotency_key = 'missing-replacement',
                  archived_at = '2026-08-12T10:30:00.000Z',
                  expires_at = '2026-09-11T10:30:00.000Z',
                  updated_at = '2026-08-12T10:30:00.000Z'
              WHERE id = ?
            `)
            .run(first.intent.id);
        })(),
      ).toThrow(/FOREIGN KEY constraint/);

      const second = fixture.ledger.change(
        setCommand(fixture, {
          body: "Second intent",
          idempotencyKey: "cycle-second",
        }),
      );
      if (second.kind !== "set") throw new Error("Expected set");
      expect(() =>
        fixture.database.connection.transaction(() => {
          fixture.database.connection
            .prepare(`
              UPDATE tab_session_intents
              SET replacement_idempotency_key = ?
              WHERE id = ?
            `)
            .run(first.intent.idempotencyKey, second.intent.id);
        })(),
      ).toThrow("session intent replacement cycle");
    } finally {
      fixture.database.close();
    }
  });

  it("rejects replacement targets from every different exact-scope dimension", () => {
    const fixture = createFixture();
    try {
      const source = fixture.ledger.change(setCommand(fixture, {
        idempotencyKey: "scope-fk-source",
      }));
      if (source.kind !== "set") throw new Error("Expected set");
      const expected = fixture.expectedPage();
      const insertTarget = fixture.database.connection.prepare(`
        INSERT INTO tab_session_intents (
          installation_id, browser_session_id, browser_tab_id,
          logical_page_id, expected_url, expected_url_normalized,
          expected_instance_revision, body, actor, method, visibility,
          state, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cross-scope target', 'user', 'manual',
          'local_only', 'active', ?, ?, ?)
      `);
      const targets = [
        {
          installationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          browserSessionId: scope.browserSessionId,
          browserTabId: scope.browserTabId,
          key: "cross-installation-target",
        },
        {
          installationId: scope.installationId,
          browserSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          browserTabId: scope.browserTabId,
          key: "cross-session-target",
        },
        {
          installationId: scope.installationId,
          browserSessionId: scope.browserSessionId,
          browserTabId: scope.browserTabId + 1,
          key: "cross-tab-target",
        },
      ];
      for (const target of targets) {
        insertTarget.run(
          target.installationId,
          target.browserSessionId,
          target.browserTabId,
          expected.logicalPageId,
          expected.url,
          expected.urlNormalized,
          expected.instanceRevision,
          target.key,
          "2026-08-12T10:00:00.000Z",
          "2026-08-12T10:00:00.000Z",
        );
      }

      for (const [index, target] of targets.entries()) {
        expect(() =>
          fixture.database.connection.transaction(() => {
            fixture.database.connection
              .prepare(`
                UPDATE tab_session_intents
                SET state = 'archived',
                    archive_idempotency_key = ?,
                    archive_cause = 'replacement',
                    replacement_idempotency_key = ?,
                    archived_at = '2026-08-12T10:10:00.000Z',
                    expires_at = '2026-09-11T10:10:00.000Z',
                    updated_at = '2026-08-12T10:10:00.000Z'
                WHERE id = ?
              `)
              .run(`cross-scope-archive-${index}`, target.key, source.intent.id);
          })(),
        ).toThrow(/FOREIGN KEY constraint/);
        expect(fixture.ledger.readLocal(scope).current?.id).toBe(source.intent.id);
      }

      fixture.setNow("2026-08-12T10:11:00.000Z");
      const valid = fixture.ledger.change(setCommand(fixture, {
        body: "same-scope target",
        idempotencyKey: "same-scope-target",
      }));
      if (valid.kind !== "set") throw new Error("Expected set");
      expect(
        fixture.database.connection
          .prepare(`
            SELECT replacement_idempotency_key
            FROM tab_session_intents WHERE id = ?
          `)
          .pluck()
          .get(source.intent.id),
      ).toBe(valid.intent.idempotencyKey);
      expect(fixture.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed without exposing malformed stored intent provenance or body", () => {
    const fixture = createFixture();
    try {
      const expected = fixture.expectedPage();
      const provenanceCanary = "PRIVATE INTENT PROVENANCE CANARY 1182";
      const bodyCanary = "PRIVATE INTENT BODY CANARY 4449";
      fixture.database.connection.pragma("ignore_check_constraints = ON");
      fixture.database.connection
        .prepare(`
          INSERT INTO tab_session_intents (
            installation_id, browser_session_id, browser_tab_id,
            logical_page_id, expected_url, expected_url_normalized,
            expected_instance_revision, body, actor, method, visibility,
            confidence, source_fingerprint, model_provenance_json, state,
            idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'model', 'local_only',
            0.5, 'source-v1', ?, 'active', 'malformed-intent-row', ?, ?)
        `)
        .run(
          scope.installationId,
          scope.browserSessionId,
          scope.browserTabId,
          expected.logicalPageId,
          expected.url,
          expected.urlNormalized,
          expected.instanceRevision,
          bodyCanary,
          JSON.stringify({
            provider: "fixture",
            name: "model",
            promptVersion: "v1",
            forbidden: provenanceCanary,
          }),
          "2026-08-12T10:00:00.000Z",
          "2026-08-12T10:00:00.000Z",
        );
      fixture.database.connection.pragma("ignore_check_constraints = OFF");

      let error: unknown;
      try {
        fixture.ledger.readLocal(scope);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toBe(
        "Error: Stored session intent provenance violates schema invariants",
      );
      expect(String(error)).not.toContain(bodyCanary);
      expect(String(error)).not.toContain(provenanceCanary);
    } finally {
      fixture.database.close();
    }
  });

  it("rolls back automatic navigation archive when the replacement insert fails", () => {
    let fail = false;
    const fixture = createFixture({
      afterArchiveBeforeSet() {
        if (fail) throw new Error("injected replacement rollback");
      },
    });
    try {
      const first = fixture.ledger.change(setCommand(fixture));
      if (first.kind !== "set") throw new Error("Expected set");
      fail = true;
      expect(() =>
        fixture.ledger.change(
          setCommand(fixture, {
            body: "Replacement",
            idempotencyKey: "replacement-intent",
          }),
        ),
      ).toThrow("injected replacement rollback");
      expect(fixture.ledger.readLocal(scope).current?.id).toBe(first.intent.id);
      expect(fixture.ledger.readLocal(scope).history).toHaveLength(1);
    } finally {
      fixture.database.close();
    }
  });
});
