import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const install = "122e4567-e89b-42d3-a456-426614174000";
const session = "222e4567-e89b-42d3-a456-426614174000";
const origin = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";
const contextFlags = {
  context: true,
  logicalImportance: false,
  priorityShadow: false,
  research: false,
  resources: false,
} as const;

async function createFixture(context = true) {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-context-routes-"));
  const databasePath = join(directory, "tabhub.sqlite");
  const app = createApp({
    databasePath,
    logger: false,
    clock: () => new Date("2026-08-12T10:00:00.000Z"),
    featureFlags: context
      ? contextFlags
      : { ...contextFlags, context: false },
    localDevProxySecret: "dev-proxy-canary-812",
  });
  let webCookie = "";
  if (context) {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/local/session/bootstrap",
      headers: { "x-tabhub-dev-proxy-secret": "dev-proxy-canary-812" },
    });
    webCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
  }
  const url = "https://example.com/context-route";
  await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      installationId: install,
      browserSessionId: session,
      tabs: [{ tabId: 7, url, title: "Context route", windowId: 1, index: 0 }],
    },
  });
  const tab = (await app.inject({ method: "GET", url: "/api/tabs" })).json()
    .items[0];
  const scope = { installationId: install, browserSessionId: session, browserTabId: 7 };
  return { app, databasePath, directory, logicalPageId: tab.id as number, scope, url, webCookie };
}

async function closeFixture(f: Awaited<ReturnType<typeof createFixture>>) {
  await f.app.close();
  await rm(f.directory, { recursive: true, force: true });
}

describe("context REST boundaries", () => {
  it("stamps local provenance and supports page CRUD, reviews, search, exact intent history and promotion", async () => {
    const f = await createFixture();
    try {
      await f.app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          installationId: "322e4567-e89b-42d3-a456-426614174000",
          browserSessionId: "422e4567-e89b-42d3-a456-426614174000",
          tabs: [{ tabId: 8, url: f.url, title: "Edge copy", windowId: 2, index: 0 }],
        },
      });
      const pagePath = `/api/local/pages/${f.logicalPageId}/context`;
      const append = await f.app.inject({
        method: "POST",
        url: `${pagePath}/commands`,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "private route canary narwhal",
          visibility: "local_only",
          idempotencyKey: "append-private",
        },
      });
      expect(append.statusCode).toBe(200);
      expect(append.json().entry.provenance).toEqual({ actor: "user", method: "manual" });
      const contextView = (
          await f.app.inject({
            method: "GET",
            url: `${pagePath}`,
            headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          })
        ).json();
      expect(contextView.context.currentEntries).toHaveLength(1);
      expect(contextView.affectedBrowserPageCount).toBe(2);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `/api/local/context/search?q=narwhal&logicalPageId=${f.logicalPageId}`,
            headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          })
        ).json(),
      ).toHaveLength(1);

      const hypothesis = await f.app.inject({
        method: "POST",
        url: `/api/agent/pages/${f.logicalPageId}/context`,
        payload: {
          kind: "append",
          entryKind: "next_action",
          body: "public hypothesis",
          provenance: { method: "on_behalf_of_user" },
          idempotencyKey: "agent-hypothesis",
        },
      });
      expect(hypothesis.json()).not.toHaveProperty("entry.id");
      const localBundle = (
        await f.app.inject({
          method: "GET",
          url: pagePath,
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        })
      ).json();
      const agentEntry = localBundle.context.currentEntries.find(
        (entry: { provenance: { actor: string } }) => entry.provenance.actor === "agent",
      );
      const review = await f.app.inject({
        method: "POST",
        url: `${pagePath}/commands`,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "review",
          entryId: agentEntry.id,
          verdict: "accepted",
          idempotencyKey: "review-agent",
        },
      });
      expect(review.json().review.provenance).toEqual({ actor: "user", method: "manual" });

      const set = await f.app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "set",
          scope: f.scope,
          expectedUrl: f.url,
          body: "Compare this exact open copy",
          visibility: "local_only",
          idempotencyKey: "intent-set",
        },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().intent.provenance).toEqual({ actor: "user", method: "manual" });
      const clientSubject = await f.app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "promote",
          intentId: set.json().intent.id,
          scope: f.scope,
          expectedPage: set.json().intent.expectedPage,
          subject: { type: "page", logicalPageId: f.logicalPageId },
          contextKind: "next_action",
          idempotencyKey: "client-subject-must-be-rejected",
        },
      });
      expect(clientSubject.statusCode).toBe(400);
      const promote = await f.app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "promote",
          intentId: set.json().intent.id,
          scope: f.scope,
          expectedPage: set.json().intent.expectedPage,
          contextKind: "next_action",
          idempotencyKey: "intent-promote",
        },
      });
      expect(promote.statusCode).toBe(200);
      expect(promote.json().context.body).toBe("Compare this exact open copy");
      const challenge = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/challenges",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: { installationId: install, extensionOrigin: origin },
      });
      const credential = await f.app.inject({
        method: "POST",
        url: "/api/local/pairing/consume",
        headers: { origin },
        payload: {
          challengeId: challenge.json().challengeId,
          installationId: install,
          code: challenge.json().code,
        },
      });
      const scopedPage = await f.app.inject({
        method: "POST",
        url: "/api/local/page-context",
        headers: {
          origin,
          authorization: `Bearer ${credential.json().credential}`,
          "x-tabhub-installation-id": install,
        },
        payload: {
          kind: "append",
          scope: f.scope,
          expectedUrl: f.url,
          entryKind: "interest",
          body: "Popup page-scope note",
          visibility: "local_only",
          idempotencyKey: "popup-page-note",
        },
      });
      expect(scopedPage.statusCode).toBe(200);
      expect(scopedPage.json().entry.provenance).toEqual({ actor: "user", method: "manual" });
      const staleScopedPage = await f.app.inject({
        method: "POST",
        url: "/api/local/page-context",
        headers: {
          origin,
          authorization: `Bearer ${credential.json().credential}`,
          "x-tabhub-installation-id": install,
        },
        payload: {
          kind: "append",
          scope: f.scope,
          expectedUrl: "https://example.com/stale",
          entryKind: "note",
          body: "Must not attach",
          visibility: "local_only",
          idempotencyKey: "stale-popup-page-note",
        },
      });
      expect(staleScopedPage.statusCode).toBe(409);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `/api/local/session-intents?${new URLSearchParams(
              Object.fromEntries(Object.entries(f.scope).map(([key, value]) => [key, String(value)])),
            )}`,
            headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          })
        ).json().history,
      ).toHaveLength(1);
      const historyPage = await f.app.inject({
        method: "GET",
        url: `/api/local/session-intents?logicalPageId=${f.logicalPageId}&state=promoted&page=1&pageSize=10`,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
      });
      expect(historyPage.statusCode).toBe(200);
      expect(historyPage.json()).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 10,
        items: [
          {
            state: "promoted",
            expectedPage: { logicalPageId: f.logicalPageId },
          },
        ],
      });
    } finally {
      await closeFixture(f);
    }
  });

  it.each(["archive", "promote"] as const)(
    "rejects stale and forged exact-page targets for %s without lifecycle effects",
    async (kind) => {
      const f = await createFixture();
      try {
        const setA = await f.app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "set",
            scope: f.scope,
            expectedUrl: f.url,
            body: "Intent bound to page A",
            visibility: "local_only",
            idempotencyKey: `exact-target-${kind}-set-a`,
          },
        });
        expect(setA.statusCode).toBe(200);
        const intentA = setA.json().intent;

        const pageB = "https://example.org/page-b";
        const navigation = await f.app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: install,
            browserSessionId: session,
            tabs: [{ tabId: 7, url: pageB, title: "Page B", windowId: 1, index: 0 }],
          },
        });
        expect(navigation.statusCode).toBe(200);

        const lifecyclePayload = {
          kind,
          intentId: intentA.id,
          scope: f.scope,
          expectedPage: intentA.expectedPage,
          ...(kind === "promote" ? { contextKind: "next_action" as const } : {}),
        };
        const staleA = await f.app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            ...lifecyclePayload,
            idempotencyKey: `exact-target-${kind}-stale-a`,
          },
        });
        expect(staleA.statusCode).toBe(409);
        expect(staleA.json()).toEqual({ error: "SESSION_SCOPE_STALE" });

        const setB = await f.app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "set",
            scope: f.scope,
            expectedUrl: pageB,
            body: "Intent bound to page B",
            visibility: "local_only",
            idempotencyKey: `exact-target-${kind}-set-b`,
          },
        });
        expect(setB.statusCode).toBe(200);
        const forgedB = await f.app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            ...lifecyclePayload,
            expectedPage: setB.json().intent.expectedPage,
            idempotencyKey: `exact-target-${kind}-forged-b`,
          },
        });
        expect(forgedB.statusCode).toBe(409);
        expect(forgedB.json()).toEqual({ error: "SESSION_SCOPE_STALE" });

        const database = new Database(f.databasePath, { readonly: true });
        try {
          expect(
            database
              .prepare(
                "SELECT state, archive_cause, promoted_context_entry_id FROM tab_session_intents WHERE id = ?",
              )
              .get(intentA.id),
          ).toEqual({
            state: "archived",
            archive_cause: "navigation",
            promoted_context_entry_id: null,
          });
          expect(
            database.prepare("SELECT COUNT(*) FROM context_entries").pluck().get(),
          ).toBe(0);
        } finally {
          database.close();
        }
      } finally {
        await closeFixture(f);
      }
    },
  );

  it("searches and previews private context only through the trusted local Library route", async () => {
    const f = await createFixture();
    try {
      const command = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "PRIVATE_LIBRARY_SEARCH_CANARY",
          visibility: "local_only",
          idempotencyKey: "private-library-search",
        },
      });
      expect(command.statusCode).toBe(200);

      const publicSearch = await f.app.inject({
        method: "GET",
        url: "/api/tabs?q=PRIVATE_LIBRARY_SEARCH_CANARY",
      });
      expect(publicSearch.statusCode).toBe(200);
      expect(publicSearch.json().total).toBe(0);
      expect(JSON.stringify(publicSearch.json())).not.toContain("contextPreview");
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: "/api/local/tabs?q=PRIVATE_LIBRARY_SEARCH_CANARY",
          })
        ).statusCode,
      ).toBe(401);

      const localSearch = await f.app.inject({
        method: "GET",
        url: "/api/local/tabs?q=PRIVATE_LIBRARY_SEARCH_CANARY",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
      });
      expect(localSearch.statusCode).toBe(200);
      expect(localSearch.json()).toMatchObject({
        total: 1,
        items: [
          {
            id: f.logicalPageId,
            contextPreview: {
              entryKind: "purpose",
              body: "PRIVATE_LIBRARY_SEARCH_CANARY",
              actor: "user",
            },
          },
        ],
      });
      const publicIds = await f.app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?q=PRIVATE_LIBRARY_SEARCH_CANARY",
      });
      expect(publicIds.statusCode).toBe(200);
      expect(publicIds.json()).toEqual({ ids: [], logicalPageCount: 0 });
      const publicInstances = await f.app.inject({
        method: "GET",
        url: "/api/tab-instances/library-bulk?q=PRIVATE_LIBRARY_SEARCH_CANARY",
      });
      expect(publicInstances.statusCode).toBe(200);
      expect(publicInstances.json()).toEqual({
        items: [], total: 0, logicalPageCount: 0,
      });

      const unauthenticatedLocalIds = await f.app.inject({
        method: "GET",
        url: "/api/local/tabs/bulk-ids?q=PRIVATE_LIBRARY_SEARCH_CANARY",
      });
      expect(unauthenticatedLocalIds.statusCode).toBe(401);
      const localIds = await f.app.inject({
        method: "GET",
        url: "/api/local/tabs/bulk-ids?q=PRIVATE_LIBRARY_SEARCH_CANARY",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
      });
      expect(localIds.statusCode).toBe(200);
      expect(localIds.json()).toEqual({
        ids: [f.logicalPageId], logicalPageCount: 1,
      });

      const unauthenticatedLocalInstances = await f.app.inject({
        method: "GET",
        url: "/api/local/tab-instances/library-bulk?q=PRIVATE_LIBRARY_SEARCH_CANARY",
      });
      expect(unauthenticatedLocalInstances.statusCode).toBe(401);
      const localInstances = await f.app.inject({
        method: "GET",
        url: "/api/local/tab-instances/library-bulk?q=PRIVATE_LIBRARY_SEARCH_CANARY",
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
      });
      expect(localInstances.statusCode).toBe(200);
      expect(localInstances.json().items).toMatchObject([
        { canonicalTabId: f.logicalPageId, browser: "chrome", browserTabId: 7 },
      ]);
    } finally {
      await closeFixture(f);
    }
  });

  it("searches only active context heads in the ordinary local Library", async () => {
    const f = await createFixture();
    const headers = { cookie: f.webCookie, "sec-fetch-site": "same-origin" };
    const search = (q: string, local = true) =>
      f.app.inject({
        method: "GET",
        url: `${local ? "/api/local/tabs" : "/api/tabs"}?q=${encodeURIComponent(q)}`,
        ...(local ? { headers } : {}),
      });
    try {
      const appended = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers,
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "WITHDRAW_RESTORE_LIBRARY_CANARY",
          visibility: "local_only",
          idempotencyKey: "library-current-append",
        },
      });
      expect(appended.statusCode).toBe(200);
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY")).json()).toMatchObject({
        total: 1,
        items: [{ contextPreview: { entryId: appended.json().entry.id } }],
      });
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY", false)).json().total).toBe(0);

      const withdrawn = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers,
        payload: {
          kind: "withdraw",
          entryId: appended.json().entry.id,
          idempotencyKey: "library-current-withdraw",
        },
      });
      expect(withdrawn.statusCode).toBe(200);
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY")).json().total).toBe(0);
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY", false)).json().total).toBe(0);

      const restored = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers,
        payload: {
          kind: "restore",
          entryId: withdrawn.json().entry.id,
          idempotencyKey: "library-current-restore",
        },
      });
      expect(restored.statusCode).toBe(200);
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY")).json()).toMatchObject({
        total: 1,
        items: [
          {
            contextPreview: {
              body: "WITHDRAW_RESTORE_LIBRARY_CANARY",
              entryId: restored.json().entry.id,
            },
          },
        ],
      });
      expect((await search("WITHDRAW_RESTORE_LIBRARY_CANARY", false)).json().total).toBe(0);
    } finally {
      await closeFixture(f);
    }
  });

  it("drops superseded context text from ordinary Library search and previews the new head", async () => {
    const f = await createFixture();
    const headers = { cookie: f.webCookie, "sec-fetch-site": "same-origin" };
    const search = (q: string, local = true) =>
      f.app.inject({
        method: "GET",
        url: `${local ? "/api/local/tabs" : "/api/tabs"}?q=${encodeURIComponent(q)}`,
        ...(local ? { headers } : {}),
      });
    try {
      const original = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers,
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "SUPERSEDED_OLD_LIBRARY_CANARY",
          visibility: "local_only",
          idempotencyKey: "library-superseded-old",
        },
      });
      expect(original.statusCode).toBe(200);

      const edited = await f.app.inject({
        method: "POST",
        url: `/api/local/pages/${f.logicalPageId}/context/commands`,
        headers,
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "SUPERSEDING_NEW_LIBRARY_CANARY",
          visibility: "local_only",
          supersedesEntryId: original.json().entry.id,
          idempotencyKey: "library-superseding-new",
        },
      });
      expect(edited.statusCode).toBe(200);
      expect((await search("SUPERSEDED_OLD_LIBRARY_CANARY")).json().total).toBe(0);
      expect((await search("SUPERSEDED_OLD_LIBRARY_CANARY", false)).json().total).toBe(0);
      expect((await search("SUPERSEDING_NEW_LIBRARY_CANARY")).json()).toMatchObject({
        total: 1,
        items: [
          {
            contextPreview: {
              body: "SUPERSEDING_NEW_LIBRARY_CANARY",
              entryId: edited.json().entry.id,
            },
          },
        ],
      });
      expect((await search("SUPERSEDING_NEW_LIBRARY_CANARY", false)).json().total).toBe(0);
    } finally {
      await closeFixture(f);
    }
  });

  it("searches current agent context in the Library only under its accepted current review", async () => {
    const f = await createFixture();
    const headers = { cookie: f.webCookie, "sec-fetch-site": "same-origin" };
    const search = (local = true) =>
      f.app.inject({
        method: "GET",
        url: `${local ? "/api/local/tabs" : "/api/tabs"}?q=AGENT_REVIEW_LIBRARY_CANARY`,
        ...(local ? { headers } : {}),
      });
    try {
      const hypothesis = await f.app.inject({
        method: "POST",
        url: `/api/agent/pages/${f.logicalPageId}/context`,
        payload: {
          kind: "append",
          entryKind: "next_action",
          body: "AGENT_REVIEW_LIBRARY_CANARY",
          provenance: { method: "on_behalf_of_user" },
          idempotencyKey: "library-agent-hypothesis",
        },
      });
      expect(hypothesis.statusCode).toBe(200);
      expect((await search()).json().total).toBe(0);
      expect((await search(false)).json().total).toBe(0);

      const context = (
        await f.app.inject({
          method: "GET",
          url: `/api/local/pages/${f.logicalPageId}/context`,
          headers,
        })
      ).json().context;
      const agentEntry = context.currentEntries.find(
        (entry: { body: string }) => entry.body === "AGENT_REVIEW_LIBRARY_CANARY",
      );
      const review = (verdict: "accepted" | "rejected", idempotencyKey: string) =>
        f.app.inject({
          method: "POST",
          url: `/api/local/pages/${f.logicalPageId}/context/commands`,
          headers,
          payload: { kind: "review", entryId: agentEntry.id, verdict, idempotencyKey },
        });

      expect((await review("rejected", "library-agent-rejected")).statusCode).toBe(200);
      expect((await search()).json().total).toBe(0);
      expect((await search(false)).json().total).toBe(0);

      expect((await review("accepted", "library-agent-accepted")).statusCode).toBe(200);
      expect((await search()).json()).toMatchObject({
        total: 1,
        items: [
          {
            contextPreview: {
              actor: "agent",
              body: "AGENT_REVIEW_LIBRARY_CANARY",
              entryId: agentEntry.id,
            },
          },
        ],
      });
      expect((await search(false)).json().total).toBe(0);

      expect((await review("rejected", "library-agent-rejected-again")).statusCode).toBe(200);
      expect((await search()).json().total).toBe(0);
      expect((await search(false)).json().total).toBe(0);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `/api/local/context/search?q=AGENT_REVIEW_LIBRARY_CANARY&logicalPageId=${f.logicalPageId}`,
            headers,
          })
        ).json(),
      ).toHaveLength(1);
    } finally {
      await closeFixture(f);
    }
  });

  it("keeps protected context search at pageSize 200 below the 1000ms p95 budget", async () => {
    const f = await createFixture();
    try {
      await f.app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: Array.from({ length: 199 }, (_, index) => ({
            url: `https://example.com/local-list-perf-${index}`,
            title: `Local list perf ${index}`,
            windowId: 2,
            index,
          })),
        },
      });
      const tabs = (
        await f.app.inject({ method: "GET", url: "/api/tabs?pageSize=200" })
      ).json().items as Array<{ id: number }>;
      expect(tabs).toHaveLength(200);
      for (const tab of tabs) {
        const appended = await f.app.inject({
          method: "POST",
          url: `/api/local/pages/${tab.id}/context/commands`,
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: `LOCAL_LIST_PERF_CANARY ${tab.id}`,
            visibility: "local_only",
            idempotencyKey: `local-list-perf-${tab.id}`,
          },
        });
        expect(appended.statusCode).toBe(200);
      }

      const durations: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const startedAt = performance.now();
        const response = await f.app.inject({
          method: "GET",
          url: "/api/local/tabs?q=LOCAL_LIST_PERF_CANARY&pageSize=200",
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        });
        durations.push(performance.now() - startedAt);
        expect(response.statusCode).toBe(200);
        expect(response.json().items).toHaveLength(200);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      expect(p95).toBeLessThan(1_000);
    } finally {
      await closeFixture(f);
    }
  });

  it("keeps agent reads/search/receipts byte-identical with hidden context and namespaces idempotency", async () => {
    const control = await createFixture();
    const hidden = await createFixture();
    try {
      await hidden.app.inject({
        method: "POST",
        url: `/api/local/pages/${hidden.logicalPageId}/context/commands`,
        headers: { cookie: hidden.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "note",
          body: "alpha hidden canary",
          visibility: "local_only",
          idempotencyKey: "same-key",
        },
      });
      const agentPayload = {
        kind: "append",
        entryKind: "note",
        body: "alpha public note",
        provenance: { method: "on_behalf_of_user" },
        idempotencyKey: "same-key",
      };
      const controlReceipt = await control.app.inject({
        method: "POST",
        url: `/api/agent/pages/${control.logicalPageId}/context`,
        payload: agentPayload,
      });
      const hiddenReceipt = await hidden.app.inject({
        method: "POST",
        url: `/api/agent/pages/${hidden.logicalPageId}/context`,
        payload: agentPayload,
      });
      expect(hiddenReceipt.body).toBe(controlReceipt.body);
      for (const f of [control, hidden]) {
        await f.app.inject({
          method: "POST",
          url: `/api/local/pages/${f.logicalPageId}/context/commands`,
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: "alpha later local",
            visibility: "share_with_ai",
            idempotencyKey: "later-write",
          },
        });
      }
      await hidden.app.inject({
        method: "POST",
        url: `/api/local/pages/${hidden.logicalPageId}/context/commands`,
        headers: { cookie: hidden.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "note",
          body: "alpha second hidden canary",
          visibility: "local_only",
          idempotencyKey: "extra-hidden-write",
        },
      });
      expect(
        (
          await control.app.inject({
            method: "POST",
            url: `/api/agent/pages/${control.logicalPageId}/context`,
            payload: agentPayload,
          })
        ).body,
      ).toBe(controlReceipt.body);
      const controlSearch = await control.app.inject({
        method: "GET",
        url: `/api/agent/context/search?q=alpha&logicalPageId=${control.logicalPageId}`,
      });
      const hiddenSearch = await hidden.app.inject({
        method: "GET",
        url: `/api/agent/context/search?q=alpha&logicalPageId=${hidden.logicalPageId}`,
      });
      expect(hiddenSearch.body).toBe(controlSearch.body);
      expect(
        (
          await hidden.app.inject({
            method: "GET",
            url: "/api/agent/context/search?q=alpha",
          })
        ).statusCode,
      ).toBe(400);
      const controlRead = await control.app.inject({
        method: "GET",
        url: `/api/agent/pages/${control.logicalPageId}/context`,
      });
      const hiddenRead = await hidden.app.inject({
        method: "GET",
        url: `/api/agent/pages/${hidden.logicalPageId}/context`,
      });
      expect(JSON.parse(hiddenRead.body)).toEqual(JSON.parse(controlRead.body));

      await hidden.app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: hidden.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "set",
          scope: hidden.scope,
          expectedUrl: hidden.url,
          body: "hidden exact intent",
          visibility: "local_only",
          idempotencyKey: "hidden-intent",
        },
      });
      const agentIntent = {
        kind: "set",
        scope: control.scope,
        expectedUrl: control.url,
        body: "public exact intent",
        provenance: { method: "on_behalf_of_user" },
        idempotencyKey: "public-intent",
      };
      const controlIntentReceipt = await control.app.inject({
        method: "POST",
        url: "/api/agent/session-intents",
        payload: agentIntent,
      });
      const hiddenIntentReceipt = await hidden.app.inject({
        method: "POST",
        url: "/api/agent/session-intents",
        payload: agentIntent,
      });
      expect(hiddenIntentReceipt.body).toBe(controlIntentReceipt.body);
      expect(hiddenIntentReceipt.json().intent).not.toHaveProperty("id");
      for (const f of [control, hidden]) {
        await f.app.inject({
          method: "POST",
          url: "/api/agent/session-intents",
          payload: {
            ...agentIntent,
            scope: f.scope,
            body: "later public exact intent",
            idempotencyKey: "later-public-intent",
          },
        });
      }
      expect(
        (
          await hidden.app.inject({
            method: "POST",
            url: "/api/agent/session-intents",
            payload: agentIntent,
          })
        ).body,
      ).toBe(controlIntentReceipt.body);
    } finally {
      await closeFixture(control);
      await closeFixture(hidden);
    }
  });

  it("keeps feature-off routes absent, zero-writes intent reconciliation, and legacy feature shape compatible", async () => {
    const f = await createFixture(false);
    try {
      expect((await f.app.inject({ method: "GET", url: "/api/features" })).json()).toEqual({
        activityWindows: false,
        agentUserImportance: false,
        context: false,
        logicalImportance: false,
        liveAcquisition: false,
        pageSummaryCapture: false,
        priorityAssessmentWriter: false,
        priorityPersonalization: false,
        priorityReaders: false,
        priorityShadow: false,
        privacyPurge: false,
        research: false,
        resources: false,
      });
      expect(
        (await f.app.inject({ method: "GET", url: `/api/agent/pages/${f.logicalPageId}/context` })).statusCode,
      ).toBe(404);
      expect(
        (await f.app.inject({ method: "GET", url: "/api/local/tabs/bulk-ids" })).statusCode,
      ).toBe(404);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: "/api/local/tab-instances/library-bulk",
          })
        ).statusCode,
      ).toBe(404);
      await f.app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: install,
          browserSessionId: session,
          tabs: [],
        },
      });
      await f.app.close();
      const database = new Database(f.databasePath, { readonly: true });
      expect(
        database.prepare("SELECT COUNT(*) FROM tab_session_intents").pluck().get(),
      ).toBe(0);
      database.close();
    } finally {
      await f.app.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("preserves context exactly across feature-off rollback and re-enable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-context-rollback-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const options = {
      databasePath,
      logger: false as const,
      featureFlags: contextFlags,
      localDevProxySecret: "rollback-secret",
      clock: () => new Date("2026-08-12T10:00:00.000Z"),
    };
    let app = createApp(options);
    try {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "rollback-secret" },
      });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [{ url: "https://example.com/rollback", windowId: 1, index: 0 }],
        },
      });
      const logicalPageId = (await app.inject({ method: "GET", url: "/api/tabs" })).json()
        .items[0].id as number;
      const commandUrl = `/api/local/pages/${logicalPageId}/context/commands`;
      await app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "Persist through rollback",
          visibility: "local_only",
          idempotencyKey: "rollback-entry",
        },
      });
      const before = (
        await app.inject({
          method: "GET",
          url: `/api/local/pages/${logicalPageId}/context`,
          headers: { cookie, "sec-fetch-site": "same-origin" },
        })
      ).json().context;
      await app.close();

      app = createApp({
        ...options,
        featureFlags: { ...contextFlags, context: false },
      });
      expect(
        (await app.inject({ method: "GET", url: `/api/agent/pages/${logicalPageId}/context` }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "POST", url: commandUrl, payload: {} })).statusCode,
      ).toBe(404);
      await app.close();

      app = createApp(options);
      const rebootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "rollback-secret" },
      });
      const recookie = String(rebootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const after = (
        await app.inject({
          method: "GET",
          url: `/api/local/pages/${logicalPageId}/context`,
          headers: { cookie: recookie, "sec-fetch-site": "same-origin" },
        })
      ).json().context;
      expect(after).toEqual(before);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("protects active user and accepted-agent purpose from retention while disposition never auto-deletes", async () => {
    const f = await createFixture();
    try {
      const commandUrl = `/api/local/pages/${f.logicalPageId}/context/commands`;
      const invalidDisposition = await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "disposition",
          body: "probably_useless",
          visibility: "local_only",
          idempotencyKey: "invalid-disposition",
        },
      });
      expect(invalidDisposition.statusCode).toBe(400);
      const userPurpose = await f.app.inject({
            method: "POST",
            url: commandUrl,
            headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
            payload: {
              kind: "append",
              entryKind: "purpose",
              body: "Active user project",
              visibility: "local_only",
              idempotencyKey: "retention-purpose",
            },
          });
      expect(userPurpose.statusCode).toBe(200);
      await f.app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: install,
          browserSessionId: session,
          tabs: [],
        },
      });
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/review?pageSize=10" })).json().total,
      ).toBe(0);

      await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "withdraw",
          entryId: userPurpose.json().entry.id,
          idempotencyKey: "withdraw-purpose",
        },
      });
      const agentPurpose = await f.app.inject({
        method: "POST",
        url: `/api/agent/pages/${f.logicalPageId}/context`,
        payload: {
          kind: "append",
          entryKind: "purpose",
          body: "Agent project hypothesis",
          provenance: { method: "on_behalf_of_user" },
          idempotencyKey: "agent-retention-purpose",
        },
      });
      expect(agentPurpose.statusCode).toBe(200);
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/review?pageSize=10" })).json().total,
      ).toBe(1);
      const context = (
        await f.app.inject({
          method: "GET",
          url: `/api/local/pages/${f.logicalPageId}/context`,
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        })
      ).json().context;
      const agentEntry = context.currentEntries.find(
        (entry: { body: string }) => entry.body === "Agent project hypothesis",
      );
      await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "review",
          entryId: agentEntry.id,
          verdict: "accepted",
          idempotencyKey: "accept-retention-purpose",
        },
      });
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/review?pageSize=10" })).json().total,
      ).toBe(0);
      const rejectedReview = await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "review",
          entryId: agentEntry.id,
          verdict: "rejected",
          idempotencyKey: "reject-retention-purpose",
        },
      });
      expect(rejectedReview.statusCode).toBe(200);
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/review?pageSize=10" })).json().total,
      ).toBe(1);
      const reacceptedReview = await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "review",
          entryId: agentEntry.id,
          verdict: "accepted",
          idempotencyKey: "reaccept-retention-purpose",
        },
      });
      expect(reacceptedReview.statusCode).toBe(200);
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/review?pageSize=10" })).json().total,
      ).toBe(0);

      const disposition = await f.app.inject({
        method: "POST",
        url: commandUrl,
        headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "append",
          entryKind: "disposition",
          body: "not_useful",
          visibility: "local_only",
          idempotencyKey: "valid-disposition",
        },
      });
      expect(disposition.statusCode).toBe(200);
      expect(
        (await f.app.inject({ method: "GET", url: "/api/retention/trash?pageSize=10" })).json().total,
      ).toBe(0);
    } finally {
      await closeFixture(f);
    }
  });

  it("keeps 50 sequential context mutations below the 500ms p95 budget", async () => {
    const f = await createFixture();
    try {
      const durations: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        const started = performance.now();
        const response = await f.app.inject({
          method: "POST",
          url: `/api/local/pages/${f.logicalPageId}/context/commands`,
          headers: { cookie: f.webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: `performance sample ${index}`,
            visibility: "local_only",
            idempotencyKey: `performance-${index}`,
          },
        });
        expect(response.statusCode).toBe(200);
        durations.push(performance.now() - started);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      expect(p95).toBeLessThanOrEqual(500);
    } finally {
      await closeFixture(f);
    }
  });

  it("expires due archived intents on one runtime cycle and purges them on the next restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-intent-maintenance-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let now = new Date("2026-01-01T00:00:00.000Z");
    let app = createApp({
      databasePath,
      logger: false,
      featureFlags: contextFlags,
      clock: () => now,
      localDevProxySecret: "maintenance-secret",
    });
    try {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "maintenance-secret" },
      });
      const webCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const url = "https://example.com/intent-maintenance";
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: install,
          browserSessionId: session,
          tabs: [{ tabId: 17, url, windowId: 1, index: 0 }],
        },
      });
      const set = await app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "set",
          scope: { installationId: install, browserSessionId: session, browserTabId: 17 },
          expectedUrl: url,
          body: "Archive and expire this",
          visibility: "local_only",
          idempotencyKey: "maintenance-set",
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/local/session-intents/commands",
        headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
        payload: {
          kind: "archive",
          intentId: set.json().intent.id,
          scope: { installationId: install, browserSessionId: session, browserTabId: 17 },
          expectedPage: set.json().intent.expectedPage,
          idempotencyKey: "maintenance-archive",
        },
      });
      await app.close();

      now = new Date("2026-02-01T00:00:00.001Z");
      app = createApp({ databasePath, logger: false, featureFlags: contextFlags, clock: () => now });
      await app.ready();
      let database = new Database(databasePath, { readonly: true });
      expect(
        database.prepare("SELECT state FROM tab_session_intents").pluck().get(),
      ).toBe("expired");
      database.close();
      await app.close();

      app = createApp({ databasePath, logger: false, featureFlags: contextFlags, clock: () => now });
      await app.ready();
      database = new Database(databasePath, { readonly: true });
      expect(
        database.prepare("SELECT COUNT(*) FROM tab_session_intents").pluck().get(),
      ).toBe(0);
      database.close();
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
