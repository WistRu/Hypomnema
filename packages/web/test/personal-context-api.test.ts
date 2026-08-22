import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiRequestError,
  changeLocalPageContext,
  changeLocalSessionIntent,
  createLocalPairingChallenge,
  fetchLocalPageContext,
  fetchLocalSessionIntents,
  resetLocalSessionBootstrapForTests,
} from "../src/api";

const now = "2026-08-12T10:00:00.000Z";
const scope = {
  installationId: "122e4567-e89b-42d3-a456-426614174000",
  browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
  browserTabId: 7,
};
const subject = { type: "page" as const, logicalPageId: 41 };
const entry = {
  id: 9,
  subject,
  entryKind: "purpose" as const,
  body: "Compare browser APIs",
  provenance: { actor: "user" as const, method: "manual" as const },
  visibility: "local_only" as const,
  staleAt: null,
  supersedesId: null,
  state: "active" as const,
  operation: "append" as const,
  revision: 1,
  idempotencyKey: "local:key",
  createdAt: now,
  withdrawnAt: null,
  currentReview: null,
};
const intent = {
  id: 12,
  scope,
  subject,
  expectedPage: {
    logicalPageId: 41,
    url: "https://example.com/docs",
    urlNormalized: "https://example.com/docs",
    instanceRevision: 1,
  },
  body: "Compare this exact copy",
  provenance: { actor: "user" as const, method: "manual" as const },
  visibility: "local_only" as const,
  staleAt: null,
  state: "active" as const,
  idempotencyKey: "local:intent",
  archivedAt: null,
  expiresAt: null,
  promotedContextEntryId: null,
  createdAt: now,
  updatedAt: now,
};

function fetchSequence(...responses: Response[]) {
  const mock = vi.fn(async () => responses.shift() ?? Response.json({}));
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => resetLocalSessionBootstrapForTests());

describe("personal context API", () => {
  it("bootstraps once, parses the page wrapper, and never puts secrets in a URL", async () => {
    const fetchMock = fetchSequence(
      new Response(null, { status: 204 }),
      Response.json({
        context: { subject, entries: [entry], currentEntries: [entry], preview: null },
        affectedBrowserPageCount: 3,
      }),
      Response.json({
        context: { subject, entries: [entry], currentEntries: [entry], preview: null },
        affectedBrowserPageCount: 3,
      }),
    );

    await expect(fetchLocalPageContext(17)).resolves.toMatchObject({
      affectedBrowserPageCount: 3,
    });
    await fetchLocalPageContext(17);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/local/session/bootstrap");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/local/tabs/17/context");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("sends strict page commands without client subject or provenance", async () => {
    const fetchMock = fetchSequence(
      new Response(null, { status: 404 }),
      Response.json({ kind: "changed", operation: "append", entry }),
    );
    await changeLocalPageContext(41, {
      kind: "append",
      entryKind: "purpose",
      body: "Compare browser APIs",
      visibility: "local_only",
      supersedesEntryId: 8,
      idempotencyKey: "retry-stable-key",
    });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/local/pages/41/context/commands");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      kind: "append",
      entryKind: "purpose",
      body: "Compare browser APIs",
      visibility: "local_only",
      supersedesEntryId: 8,
      idempotencyKey: "retry-stable-key",
    });
    expect(body).not.toHaveProperty("subject");
    expect(body).not.toHaveProperty("provenance");
  });

  it("uses exact scope for read/set and omits the server-derived promotion subject", async () => {
    const fetchMock = fetchSequence(
      new Response(null, { status: 204 }),
      Response.json({ scope, current: intent, history: [intent] }),
      Response.json({ kind: "set", intent }),
      Response.json({ kind: "promoted", intent: { ...intent, state: "promoted", promotedContextEntryId: 9 }, context: entry }),
    );

    await fetchLocalSessionIntents(scope);
    await changeLocalSessionIntent({
      kind: "set",
      scope,
      expectedUrl: "https://example.com/docs",
      body: "Compare this exact copy",
      visibility: "local_only",
      idempotencyKey: "intent-set",
    });
    await changeLocalSessionIntent({
      kind: "promote",
      intentId: 12,
      contextKind: "next_action",
      scope,
      expectedPage: intent.expectedPage,
      idempotencyKey: "intent-promote",
    });

    expect(fetchMock.mock.calls[1]?.[0]).toContain("installationId=");
    const promote = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(promote).toEqual({
      kind: "promote",
      intentId: 12,
      contextKind: "next_action",
      scope,
      expectedPage: intent.expectedPage,
      idempotencyKey: "intent-promote",
    });
    expect(promote).not.toHaveProperty("subject");
    expect(promote).not.toHaveProperty("provenance");
  });

  it("routes withdraw, restore, review, and intent archive through closed local command unions", async () => {
    const fetchMock = fetchSequence(
      new Response(null, { status: 204 }),
      Response.json({ kind: "changed", operation: "withdraw", entry: { ...entry, id: 10, state: "withdrawn", operation: "withdraw", supersedesId: 9, revision: 2, withdrawnAt: now } }),
      Response.json({ kind: "changed", operation: "restore", entry: { ...entry, id: 11, operation: "restore", supersedesId: 10, revision: 3 } }),
      Response.json({ kind: "reviewed", review: { id: 2, contextEntryId: 9, verdict: "rejected", provenance: { actor: "user", method: "manual" }, idempotencyKey: "local:review", supersedesId: null, createdAt: now } }),
      Response.json({ kind: "archived", intent: { ...intent, state: "archived", archivedAt: now } }),
    );

    await changeLocalPageContext(41, { kind: "withdraw", entryId: 9, idempotencyKey: "withdraw" });
    await changeLocalPageContext(41, { kind: "restore", entryId: 10, idempotencyKey: "restore" });
    await changeLocalPageContext(41, { kind: "review", entryId: 9, verdict: "rejected", idempotencyKey: "review" });
    await changeLocalSessionIntent({
      kind: "archive",
      intentId: 12,
      scope,
      expectedPage: intent.expectedPage,
      idempotencyKey: "archive",
    });

    expect(fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { kind: "withdraw", entryId: 9, idempotencyKey: "withdraw" },
      { kind: "restore", entryId: 10, idempotencyKey: "restore" },
      { kind: "review", entryId: 9, verdict: "rejected", idempotencyKey: "review" },
      {
        kind: "archive",
        intentId: 12,
        scope,
        expectedPage: intent.expectedPage,
        idempotencyKey: "archive",
      },
    ]);
  });

  it("creates pairing challenges in a body and preserves stable typed errors", async () => {
    const challenge = {
      challengeId: "322e4567-e89b-42d3-a456-426614174000",
      code: "x".repeat(43),
      expiresAt: now,
    };
    const fetchMock = fetchSequence(
      new Response(null, { status: 204 }),
      Response.json(challenge),
      Response.json({ error: "SESSION_SCOPE_STALE" }, { status: 409 }),
    );
    await createLocalPairingChallenge({
      extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
      installationId: scope.installationId,
    });
    await expect(
      changeLocalSessionIntent({
        kind: "archive",
        intentId: 12,
        scope,
        expectedPage: intent.expectedPage,
        idempotencyKey: "archive",
      }),
    ).rejects.toMatchObject<ApiRequestError>({
      code: "SESSION_SCOPE_STALE",
      status: 409,
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/local/pairing/challenges");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain(challenge.code);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
      installationId: scope.installationId,
    });
  });
});
