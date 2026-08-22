import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tabCommandRelayProtocolVersion } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createApp } from "../src/app.js";
import {
  personalAttentionFeatureFlagsOff,
  resolvePersonalAttentionFeatureFlags,
} from "../src/attention-feature-flags.js";

describe("page-summary capture feature boundary", () => {
  it("keeps capture default-off and parses only explicit booleans", () => {
    expect(resolvePersonalAttentionFeatureFlags({}))
      .toEqual(personalAttentionFeatureFlagsOff);
    expect(personalAttentionFeatureFlagsOff.pageSummaryCapture).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_PAGE_SUMMARY_CAPTURE: "true",
    }).pageSummaryCapture).toBe(true);
    expect(() => resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_PAGE_SUMMARY_CAPTURE: "enabled",
    })).toThrow(
      "TABHUB_FEATURE_PAGE_SUMMARY_CAPTURE must be one of",
    );
  });

  it("rejects only capture before WebSocket dispatch while disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-capture-relay-off-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      tabCommandRelayCommandTimeoutMs: 50,
    });
    let socket: WebSocket | undefined;
    try {
      await app.ready();
      socket = await app.injectWS("/api/tab-command-relay/ws", {
        headers: {
          host: "127.0.0.1:7717",
          origin: "chrome-extension://tabhubtest",
        },
      });
      const ready = nextMessage(socket);
      socket.send(JSON.stringify({
        scope,
        type: "register",
        version: tabCommandRelayProtocolVersion,
      }));
      await expect(ready).resolves.toMatchObject({ type: "ready" });

      const receivedCommand = vi.fn();
      socket.on("message", receivedCommand);
      const response = await app.inject({
        headers: relayHeaders,
        method: "POST",
        payload: {
          ...scope,
          command: { kind: "capture-tab-content", target },
        },
        url: "/api/tab-command-relay/commands",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "PAGE_SUMMARY_CAPTURE_UNAVAILABLE",
        message: "Page-summary capture is disabled on this TabHub server.",
        ok: false,
        outcome: "not-sent",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(receivedCommand).not.toHaveBeenCalled();

      const stateMessage = nextMessage(socket);
      const stateResponse = app.inject({
        headers: relayHeaders,
        method: "POST",
        payload: { ...scope, command: { kind: "get-browser-state" } },
        url: "/api/tab-command-relay/commands",
      });
      const stateEnvelope = await stateMessage as { requestId: string };
      expect(stateEnvelope).toMatchObject({
        command: { kind: "get-browser-state" },
        type: "command",
      });
      socket.send(JSON.stringify({
        ok: true,
        requestId: stateEnvelope.requestId,
        result: { kind: "get-browser-state", pendingUndos: [], windows: [] },
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }));
      expect((await stateResponse).statusCode).toBe(200);
      expect(receivedCommand).toHaveBeenCalledTimes(1);
    } finally {
      socket?.terminate();
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not register exact ingest while ordinary captured content stays unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-capture-ingest-off-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    const url = "https://example.com/existing-content";
    try {
      expect((await app.inject({
        method: "POST",
        payload: {
          ...scope,
          tabs: [{ index: 0, tabId: 42, title: "Existing", url, windowId: 1 }],
        },
        url: "/api/ingest/snapshot",
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "POST",
        payload: {
          browser: scope.browser,
          htmlExcerpt: "<main>existing</main>",
          text: "Existing captured content.",
          url,
        },
        url: "/api/ingest/content",
      })).statusCode).toBe(200);
      const list = await app.inject({ method: "GET", url: "/api/tabs" });
      const canonicalTabId = list.json().items[0].id as number;
      const before = (await app.inject({
        method: "GET",
        url: `/api/tabs/${canonicalTabId}`,
      })).json().content;

      const exact = await app.inject({
        headers: {
          "sec-fetch-site": "cross-site",
          "x-tabhub-extension-origin": "chrome-extension://tabhubtest",
        },
        method: "POST",
        payload: {
          ...scope,
          commandRequestId: "723e4567-e89b-42d3-a456-426614174000",
          htmlExcerpt: "<main>must not replace</main>",
          observedUrl: url,
          target: { ...target, expectedUrl: url },
          text: "Must not replace existing captured content.",
        },
        url: "/api/ingest/exact-instance-content",
      });
      expect(exact.statusCode).toBe(404);
      expect((await app.inject({
        method: "GET",
        url: `/api/tabs/${canonicalTabId}`,
      })).json().content).toEqual(before);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves the legacy short-summary action for existing content while off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-capture-summary-off-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: {
        modelFor: () => "test-short-model",
        summarize: vi.fn().mockResolvedValue({
          model: "test-short-model",
          summary: "Legacy short summary remains available.",
          usage: { costUsd: 0, inputTokens: 4, outputTokens: 5 },
        }),
      },
      summaryWorkerPollMs: 5,
    });
    const url = "https://example.com/legacy-summary";
    try {
      await app.inject({
        method: "POST",
        payload: {
          browser: "chrome",
          tabs: [{ index: 0, title: "Legacy summary", url, windowId: 1 }],
        },
        url: "/api/ingest/snapshot",
      });
      await app.inject({
        method: "POST",
        payload: {
          browser: "chrome",
          htmlExcerpt: "<article>legacy</article>",
          text: "Existing content for the legacy short-summary action.",
          url,
        },
        url: "/api/ingest/content",
      });
      const tabId = (await app.inject({ method: "GET", url: "/api/tabs" }))
        .json().items[0].id as number;
      const response = await app.inject({
        method: "POST",
        payload: { depth: "short" },
        url: `/api/tabs/${tabId}/summarize`,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        jobId: expect.any(Number),
        sourceContentRevision: 1,
      });
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("advertises the optional capability only from the dedicated flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-capture-feature-"));
    const off = createApp({
      databasePath: join(directory, "off.sqlite"),
      logger: false,
    });
    const on = createApp({
      databasePath: join(directory, "on.sqlite"),
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        pageSummaryCapture: true,
        research: false,
      },
      logger: false,
    });
    try {
      expect((await off.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ pageSummaryCapture: false });
      expect((await on.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ pageSummaryCapture: true });
    } finally {
      await off.close();
      await on.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

const scope = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const relayHeaders = {
  origin: "http://127.0.0.1:7717",
  "sec-fetch-site": "same-origin",
} as const;
const target = {
  instanceId: 17,
  tabId: 42,
  expectedUrl: "https://example.com/article",
  expectedInstanceRevision: 3,
  expectedFirstSeenAt: "2026-08-13T11:00:00.000Z",
} as const;

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
