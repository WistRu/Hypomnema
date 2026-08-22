import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tabCommandRelayProtocolVersion,
  type ExactInstanceCaptureReceipt,
  type SummaryJobResult,
  type TabCommandRelayCaptureTarget,
  type TabCommandScope,
} from "@tabhub/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createApp, type TabHubApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";
import type { SummaryProvider } from "../src/summary-provider.js";

const scope = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const extensionOrigin = "chrome-extension://tabhubtest";
const relayHeaders = {
  origin: "http://127.0.0.1:7717",
  "sec-fetch-site": "same-origin",
} as const;
const extensionHeaders = {
  "sec-fetch-site": "cross-site",
  "x-tabhub-extension-origin": extensionOrigin,
} as const;

const summaryResult: SummaryJobResult = {
  summary: "Captured summary",
  model: "test-model",
  usage: { inputTokens: 5, outputTokens: 3, costUsd: 0 },
};

describe("exact-instance capture", () => {
  let app: TabHubApp;
  let directory: string;
  let now: Date;
  let sockets: WebSocket[];
  let summarize: ReturnType<typeof vi.fn<SummaryProvider["summarize"]>>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tabhub-exact-capture-"));
    now = new Date("2026-08-13T12:00:00.000Z");
    sockets = [];
    summarize = vi.fn<SummaryProvider["summarize"]>().mockResolvedValue(summaryResult);
    app = createApp({
      clock: () => now,
      databasePath: join(directory, "tabhub.sqlite"),
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        pageSummaryCapture: true,
      },
      logger: false,
      summaryProvider: {
        modelFor: () => "test-model",
        summarize,
      },
      tabCommandRelayCommandTimeoutMs: 5_000,
    });
    await app.ready();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(directory, { force: true, recursive: true });
  });

  async function snapshot(tabs: Array<{ tabId: number; url: string; index: number }>) {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/snapshot",
      payload: {
        ...scope,
        tabs: tabs.map((tab) => ({
          ...tab,
          title: `Tab ${tab.tabId}`,
          windowId: 1,
        })),
      },
    });
    expect(response.statusCode).toBe(200);
  }

  async function targetFor(browserTabId: number): Promise<TabCommandRelayCaptureTarget> {
    const response = await app.inject({
      method: "GET",
      url: "/api/tab-instances?pageSize=50",
    });
    expect(response.statusCode).toBe(200);
    const instance = response.json().items.find(
      (item: { browserTabId: number }) => item.browserTabId === browserTabId,
    );
    expect(instance).toBeDefined();
    return {
      instanceId: instance.instanceId,
      tabId: browserTabId,
      expectedUrl: instance.url,
      expectedInstanceRevision: instance.instanceRevision,
      expectedFirstSeenAt: instance.firstSeenAt,
    };
  }

  async function registeredSocket(
    commandScope: TabCommandScope = scope,
  ): Promise<WebSocket> {
    const socket = await app.injectWS("/api/tab-command-relay/ws", {
      headers: { host: "127.0.0.1:7717", origin: extensionOrigin },
    });
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({
      scope: commandScope,
      type: "register",
      version: tabCommandRelayProtocolVersion,
    }));
    await expect(ready).resolves.toMatchObject({ type: "ready" });
    return socket;
  }

  async function beginCapture(
    target: TabCommandRelayCaptureTarget,
    commandScope: TabCommandScope = scope,
  ) {
    const socket = await registeredSocket(commandScope);
    const commandMessage = nextMessage(socket);
    const commandResponse = app.inject({
      headers: relayHeaders,
      method: "POST",
      payload: { ...commandScope, command: { kind: "capture-tab-content", target } },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage as {
      executionDeadlineAt: number;
      requestId: string;
    };
    expect(envelope).toMatchObject({
      command: { kind: "capture-tab-content", target },
      executionDeadlineAt: expect.any(Number),
      requestId: expect.any(String),
      type: "command",
      version: tabCommandRelayProtocolVersion,
    });

    const ingest = (
      overrides: Record<string, unknown> = {},
      headers: Record<string, string> = extensionHeaders,
    ) => app.inject({
      headers,
      method: "POST",
      payload: {
        ...commandScope,
        commandRequestId: envelope.requestId,
        target,
        observedUrl: target.expectedUrl,
        text: `content from native tab ${target.tabId}`,
        htmlExcerpt: `<main>${target.tabId}</main>`,
        ...overrides,
      },
      url: "/api/ingest/exact-instance-content",
    });
    const sendResult = (result: unknown) => socket.send(JSON.stringify({
      ok: true,
      requestId: envelope.requestId,
      result,
      scope: commandScope,
      type: "result",
      version: tabCommandRelayProtocolVersion,
    }));
    return {
      commandRequestId: envelope.requestId,
      commandResponse,
      ingest,
      sendCaptured(receipt: ExactInstanceCaptureReceipt) {
        sendResult({
          kind: "capture-tab-content",
          target,
          outcome: { status: "captured", receipt },
        });
      },
      sendFailure(code: string, observedUrl?: string) {
        sendResult({
          kind: "capture-tab-content",
          target,
          outcome: {
            status: "failed",
            failure: {
              code,
              message: "Capture did not complete.",
              recoverable: true,
              ...(observedUrl === undefined ? {} : { observedUrl }),
            },
          },
        });
      },
      sendCommandError() {
        socket.send(JSON.stringify({
          error: "Capture failed before ingest.",
          ok: false,
          requestId: envelope.requestId,
          scope: commandScope,
          type: "result",
          version: tabCommandRelayProtocolVersion,
        }));
      },
      socket,
      target,
    };
  }

  async function capture(
    target: TabCommandRelayCaptureTarget,
    overrides: Record<string, unknown> = {},
  ) {
    const session = await beginCapture(target);
    const response = await session.ingest(overrides);
    if (response.statusCode === 200) {
      session.sendCaptured(response.json());
    } else {
      session.sendFailure(response.json().error, response.json().observedUrl);
    }
    expect((await session.commandResponse).statusCode).toBe(200);
    return response;
  }

  async function contentFor(canonicalTabId: number) {
    const response = await app.inject({
      method: "GET",
      url: `/api/tabs/${canonicalTabId}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().content;
  }

  it("captures only the selected duplicate copy through its active relay grant", async () => {
    const url = "https://example.com/same-page";
    await snapshot([
      { tabId: 11, url, index: 0 },
      { tabId: 22, url, index: 1 },
    ]);
    const target = await targetFor(22);
    const response = await capture(target);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      browserTabId: 22,
      capturedUrl: url,
      contentRevision: 1,
      instanceId: target.instanceId,
      instanceRevision: target.expectedInstanceRevision,
      firstSeenAt: target.expectedFirstSeenAt,
      canonicalTabId: expect.any(Number),
      logicalPageId: expect.any(Number),
      extractedAt: "2026-08-13T12:00:00.000Z",
    });
    const instances = await app.inject({
      method: "GET",
      url: "/api/tab-instances?pageSize=50",
    });
    expect(instances.json()).toMatchObject({ total: 2 });
    expect(new Set(instances.json().items.map(
      (item: { canonicalTabId: number }) => item.canonicalTabId,
    )).size).toBe(1);
    expect(await contentFor(response.json().canonicalTabId)).toMatchObject({
      contentRevision: 1,
      text: "content from native tab 22",
    });
  });

  it("accepts the canonical extension header alone and rejects conflicting origins", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/origin", index: 0 }]);
    const target = await targetFor(22);
    const headerOnly = await capture(target);
    expect(headerOnly.statusCode).toBe(200);

    const session = await beginCapture(target);
    const mismatch = await session.ingest(
      { text: "must not be stored" },
      {
        origin: "chrome-extension://different",
        "x-tabhub-extension-origin": extensionOrigin,
      },
    );
    expect(mismatch.statusCode).toBe(403);
    session.sendFailure("CAPTURE_INGEST_REJECTED");
    expect((await session.commandResponse).statusCode).toBe(200);
    expect(await contentFor(headerOnly.json().canonicalTabId)).toMatchObject({
      contentRevision: 1,
      text: "content from native tab 22",
    });
  });

  it("requires an active opaque command id and purges it after completion", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/grant", index: 0 }]);
    const target = await targetFor(22);
    const noId = await app.inject({
      headers: extensionHeaders,
      method: "POST",
      payload: { ...scope, target, observedUrl: target.expectedUrl, text: "x", htmlExcerpt: "" },
      url: "/api/ingest/exact-instance-content",
    });
    expect(noId.statusCode).toBe(400);

    const unknown = await app.inject({
      headers: extensionHeaders,
      method: "POST",
      payload: {
        ...scope,
        commandRequestId: "323e4567-e89b-42d3-a456-426614174000",
        target,
        observedUrl: target.expectedUrl,
        text: "x",
        htmlExcerpt: "",
      },
      url: "/api/ingest/exact-instance-content",
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({
      error: "CAPTURE_COMMAND_NOT_ACTIVE",
      recoverable: true,
    });

    const session = await beginCapture(target);
    const stored = await session.ingest();
    session.sendCaptured(stored.json());
    expect((await session.commandResponse).statusCode).toBe(200);
    const replay = await session.ingest();
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "CAPTURE_COMMAND_NOT_ACTIVE" });
  });

  it("makes an identical in-flight retry idempotent and rejects a changed payload", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/retry", index: 0 }]);
    const target = await targetFor(22);
    const session = await beginCapture(target);
    const first = await session.ingest();
    const retry = await session.ingest();
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    const changed = await session.ingest({ text: "different payload" });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: "CAPTURE_COMMAND_MISMATCH" });
    session.sendCaptured(first.json());
    expect((await session.commandResponse).statusCode).toBe(200);
    expect(await contentFor(first.json().canonicalTabId)).toMatchObject({
      contentRevision: 1,
    });
  });

  it.each([
    ["wrong installation", { installationId: "323e4567-e89b-42d3-a456-426614174000" }],
    ["wrong session", { browserSessionId: "423e4567-e89b-42d3-a456-426614174000" }],
  ])("fails closed when the payload claims %s", async (_name, override) => {
    await snapshot([{ tabId: 22, url: "https://example.com/scope", index: 0 }]);
    const target = await targetFor(22);
    const session = await beginCapture(target);
    const response = await session.ingest(override);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "CAPTURE_COMMAND_MISMATCH",
      recoverable: true,
    });
    session.sendFailure("CAPTURE_SCOPE_MISMATCH");
    expect((await session.commandResponse).statusCode).toBe(200);
    expect(await contentFor((await targetCanonicalId(target)))).toBeNull();
  });

  async function targetCanonicalId(target: TabCommandRelayCaptureTarget): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: "/api/tab-instances?pageSize=50",
    });
    return response.json().items.find(
      (item: { instanceId: number }) => item.instanceId === target.instanceId,
    ).canonicalTabId;
  }

  it("rejects target drift and legacy nullable physical identity", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/native", index: 0 }]);
    const target = await targetFor(22);
    const session = await beginCapture(target);
    const wrongNative = await session.ingest({ target: { ...target, tabId: 23 } });
    expect(wrongNative.statusCode).toBe(409);
    expect(wrongNative.json()).toMatchObject({ error: "CAPTURE_COMMAND_MISMATCH" });
    session.sendFailure("CAPTURE_SCOPE_MISMATCH");
    expect((await session.commandResponse).statusCode).toBe(200);

    const legacySnapshot = await app.inject({
      method: "POST",
      url: "/api/ingest/snapshot",
      payload: {
        browser: "edge",
        tabs: [{ url: "https://example.com/legacy", title: "Legacy", windowId: 1, index: 0 }],
      },
    });
    expect(legacySnapshot.statusCode).toBe(200);
    const instances = await app.inject({
      method: "GET",
      url: "/api/tab-instances?browser=edge&pageSize=50",
    });
    const legacy = instances.json().items[0];
    const legacyTarget = {
      instanceId: legacy.instanceId,
      tabId: 1,
      expectedUrl: legacy.url,
      expectedInstanceRevision: legacy.instanceRevision,
      expectedFirstSeenAt: legacy.firstSeenAt,
    };
    const legacyScope = { ...scope, browser: "edge" as const };
    const legacySession = await beginCapture(legacyTarget, legacyScope);
    const legacyCapture = await legacySession.ingest();
    expect(legacyCapture.statusCode).toBe(409);
    expect(legacyCapture.json()).toMatchObject({ error: "CAPTURE_SCOPE_MISMATCH" });
    legacySession.sendFailure("CAPTURE_SCOPE_MISMATCH");
    expect((await legacySession.commandResponse).statusCode).toBe(200);
  });

  it("distinguishes observed navigation, stored navigation, stale and missing instances", async () => {
    const originalUrl = "https://example.com/original";
    await snapshot([{ tabId: 22, url: originalUrl, index: 0 }]);
    const original = await targetFor(22);

    const observedSession = await beginCapture(original);
    const observed = await observedSession.ingest({
      observedUrl: "https://example.com/observed-after-navigation",
    });
    expect(observed.statusCode).toBe(409);
    expect(observed.json()).toMatchObject({ error: "CAPTURE_TAB_NAVIGATED" });
    observedSession.sendFailure("CAPTURE_TAB_NAVIGATED", observed.json().observedUrl);
    expect((await observedSession.commandResponse).statusCode).toBe(200);

    await snapshot([{ tabId: 22, url: "https://example.com/other", index: 0 }]);
    const navigatedSession = await beginCapture(original);
    const navigated = await navigatedSession.ingest();
    expect(navigated.statusCode).toBe(409);
    expect(navigated.json()).toMatchObject({
      error: "CAPTURE_TAB_NAVIGATED",
      observedUrl: "https://example.com/other",
    });
    navigatedSession.sendFailure("CAPTURE_TAB_NAVIGATED", navigated.json().observedUrl);
    expect((await navigatedSession.commandResponse).statusCode).toBe(200);

    await snapshot([{ tabId: 22, url: originalUrl, index: 0 }]);
    const staleSession = await beginCapture(original);
    const stale = await staleSession.ingest();
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "CAPTURE_INSTANCE_STALE" });
    staleSession.sendFailure("CAPTURE_INSTANCE_STALE");
    expect((await staleSession.commandResponse).statusCode).toBe(200);

    await snapshot([]);
    const missingSession = await beginCapture(original);
    const missing = await missingSession.ingest();
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "CAPTURE_INSTANCE_MISSING" });
    missingSession.sendFailure("CAPTURE_INSTANCE_MISSING");
    expect((await missingSession.commandResponse).statusCode).toBe(200);
  });

  it("uses firstSeenAt as an ABA fence when an instance id is recycled", async () => {
    const url = "https://example.com/aba";
    await snapshot([{ tabId: 22, url, index: 0 }]);
    const original = await targetFor(22);
    const session = await beginCapture(original);
    await snapshot([]);
    now = new Date("2026-08-13T12:00:01.000Z");
    await snapshot([{ tabId: 22, url, index: 0 }]);
    const replacement = await targetFor(22);
    expect(replacement.instanceId).toBe(original.instanceId);
    expect(replacement.expectedFirstSeenAt).not.toBe(original.expectedFirstSeenAt);
    const response = await session.ingest();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CAPTURE_INSTANCE_STALE" });
    session.sendFailure("CAPTURE_INSTANCE_STALE");
    expect((await session.commandResponse).statusCode).toBe(200);
  });

  it("rejects unsupported pages without storing their extracted payload", async () => {
    await snapshot([{ tabId: 33, url: "chrome://settings/", index: 0 }]);
    const target = await targetFor(33);
    const response = await capture(target);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "CAPTURE_PAGE_UNSUPPORTED",
      recoverable: true,
    });
    expect(await contentFor(await targetCanonicalId(target))).toBeNull();
  });

  it.each(["", " \r\n\t "])(
    "rejects blank extracted text without creating a content revision (%j)",
    async (text) => {
      await snapshot([{ tabId: 34, url: "https://example.com/blank", index: 0 }]);
      const target = await targetFor(34);
      const response = await capture(target, { text });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "CAPTURE_EXTRACTION_FAILED",
        recoverable: true,
      });
      expect(await contentFor(await targetCanonicalId(target))).toBeNull();
    },
  );

  it("expires a grant before ingest and resolves the command as timed out", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/timeout", index: 0 }]);
    const session = await beginCapture(await targetFor(22));
    now = new Date("2026-08-13T12:01:00.000Z");
    const response = await session.ingest();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CAPTURE_COMMAND_NOT_ACTIVE" });
    const command = await session.commandResponse;
    expect(command.statusCode).toBe(504);
    expect(command.json()).toMatchObject({ error: "COMMAND_TIMEOUT" });
  });

  it("purges a grant when its owning extension disconnects", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/disconnect", index: 0 }]);
    const session = await beginCapture(await targetFor(22));
    session.socket.terminate();
    const command = await session.commandResponse;
    expect(command.statusCode).toBe(502);
    expect(command.json()).toMatchObject({ error: "EXTENSION_DISCONNECTED" });
    const response = await session.ingest();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CAPTURE_COMMAND_NOT_ACTIVE" });
  });

  it("rejects captured and generic failure results that contradict grant state", async () => {
    await snapshot([{ tabId: 22, url: "https://example.com/correlation", index: 0 }]);
    const target = await targetFor(22);

    const withoutIngest = await beginCapture(target);
    withoutIngest.sendCaptured({
      instanceId: target.instanceId,
      browserTabId: target.tabId,
      canonicalTabId: await targetCanonicalId(target),
      logicalPageId: 1,
      capturedUrl: target.expectedUrl,
      instanceRevision: target.expectedInstanceRevision,
      firstSeenAt: target.expectedFirstSeenAt,
      contentRevision: 1,
      extractedAt: now.toISOString(),
    });
    expect((await withoutIngest.commandResponse).statusCode).toBe(502);

    const afterIngest = await beginCapture(target);
    const stored = await afterIngest.ingest();
    afterIngest.sendCommandError();
    const rejected = await afterIngest.commandResponse;
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json()).toMatchObject({ error: "INVALID_COMMAND_RECEIPT" });
    expect(await contentFor(stored.json().canonicalTabId)).toMatchObject({
      contentRevision: 1,
    });

    const afterSecondIngest = await beginCapture(target);
    const secondStored = await afterSecondIngest.ingest({ text: "second revision" });
    afterSecondIngest.sendFailure("CAPTURE_EXTRACTION_FAILED");
    const typedFailure = await afterSecondIngest.commandResponse;
    expect(typedFailure.statusCode).toBe(502);
    expect(typedFailure.json()).toMatchObject({ error: "INVALID_COMMAND_RECEIPT" });
    expect(await contentFor(secondStored.json().canonicalTabId)).toMatchObject({
      contentRevision: 2,
      text: "second revision",
    });
  });

  it("binds summary enqueue and job reads to the captured revision", async () => {
    await snapshot([{ tabId: 44, url: "https://example.com/summary", index: 0 }]);
    const target = await targetFor(44);
    const first = (await capture(target)).json();

    const mismatch = await app.inject({
      method: "POST",
      url: `/api/tabs/${first.canonicalTabId}/summarize`,
      payload: { depth: "deep", expectedContentRevision: first.contentRevision + 1 },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: "TAB_CONTENT_REVISION_MISMATCH",
      expectedContentRevision: 2,
      currentContentRevision: 1,
    });
    expect(summarize).not.toHaveBeenCalled();

    const queued = await app.inject({
      method: "POST",
      url: `/api/tabs/${first.canonicalTabId}/summarize`,
      payload: { depth: "deep", expectedContentRevision: first.contentRevision },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ sourceContentRevision: 1 });
    const job = await app.inject({ method: "GET", url: `/api/jobs/${queued.json().jobId}` });
    expect(job.json()).toMatchObject({
      sourceContentRevision: 1,
      currentContentRevision: 1,
      contentRevisionMatches: true,
    });

    const recaptured = await capture(target, {
      text: "new revision",
      htmlExcerpt: "<main>new revision</main>",
    });
    expect(recaptured.json().contentRevision).toBe(2);
    const staleJob = await app.inject({ method: "GET", url: `/api/jobs/${queued.json().jobId}` });
    expect(staleJob.json()).toMatchObject({
      sourceContentRevision: 1,
      currentContentRevision: 2,
      contentRevisionMatches: false,
    });
  });
});

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
}
