import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SummaryJob, SummaryJobResult } from "@tabhub/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { createSummaryCatalog } from "../src/summary-catalog.js";
import {
  SummaryProviderError,
  type SummaryProvider,
} from "../src/summary-provider.js";

async function seedCapturedTab(
  app: ReturnType<typeof createApp>,
  suffix = "summary",
): Promise<number> {
  await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      tabs: [
        {
          url: `https://example.com/${suffix}`,
          title: `Captured ${suffix}`,
          windowId: 1,
          index: 0,
        },
      ],
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/ingest/content",
    payload: {
      browser: "chrome",
      url: `https://example.com/${suffix}`,
      text: `Long-form captured content for ${suffix}.`,
      htmlExcerpt: `<article>${suffix}</article>`,
    },
  });
  const list = await app.inject({ method: "GET", url: "/api/tabs" });

  return list.json().items[0].id as number;
}

async function waitForJob(
  app: ReturnType<typeof createApp>,
  jobId: number,
  expectedStatus: SummaryJob["status"],
  timeoutMs = 5_000,
): Promise<SummaryJob> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const job = response.json() as SummaryJob;
    if (job.status === expectedStatus) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Summary job ${jobId} did not become ${expectedStatus}`);
}

function summaryResult(summary: string): SummaryJobResult {
  return {
    summary,
    model: "test-haiku",
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0002 },
  };
}

describe("summary jobs", () => {
  it("does not queue work when no explicit summary provider is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-offline-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabId = await seedCapturedTab(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "SUMMARY_PROVIDER_UNAVAILABLE",
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates requests and requires captured text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-errors-"));
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async () => summaryResult("unused"),
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
    });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/tabs/999999/summarize",
        payload: { depth: "short" },
      });
      expect(missing.statusCode).toBe(404);

      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/no-content",
              title: "No content",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const listed = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = listed.json().items[0].id as number;
      const noContent = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      expect(noContent.statusCode).toBe(409);
      expect(noContent.json()).toMatchObject({ error: "TAB_CONTENT_MISSING" });

      const invalid = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "automatic" },
      });
      expect(invalid.statusCode).toBe(400);

      const unknownJob = await app.inject({
        method: "GET",
        url: "/api/jobs/999999",
      });
      expect(unknownJob.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("queues explicitly, reuses active work, and stores a searchable summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-success-"));
    let release: ((result: SummaryJobResult) => void) | undefined;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async () =>
        new Promise<SummaryJobResult>((resolve) => {
          release = resolve;
        }),
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 10,
    });

    try {
      const tabId = await seedCapturedTab(app, "explicit");
      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      expect(queued.statusCode).toBe(202);
      const jobId = queued.json().jobId as number;
      await waitForJob(app, jobId, "running");

      const repeated = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      expect(repeated.json()).toEqual({
        jobId,
        sourceContentRevision: 1,
        status: "running",
      });

      release?.(summaryResult("A unique capybara summary."));
      const completed = await waitForJob(app, jobId, "succeeded");
      expect(completed).toMatchObject({
        attempts: 1,
        result: {
          summary: "A unique capybara summary.",
          model: "test-haiku",
          usage: { costUsd: 0.0002 },
        },
      });

      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.json().content).toMatchObject({
        summary: "A unique capybara summary.",
        summaryModel: "test-haiku",
      });
      const search = await app.inject({
        method: "GET",
        url: "/api/tabs?q=capybara",
      });
      expect(search.json().total).toBe(1);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("projects only active reviewed shareable page context into the summary provider input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-context-"));
    let providerContext: Parameters<SummaryProvider["summarize"]>[0]["context"];
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async (input) => {
        providerContext = input.context;
        return summaryResult("Context-aware summary.");
      },
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      featureFlags: {
        context: true,
        logicalImportance: true,
        priorityShadow: false,
        research: false,
        resources: false,
      },
      localDevProxySecret: "summary-context-secret",
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "context-projection");
      const logicalPage = await app.inject({
        method: "GET",
        url: `/api/logical-pages/by-tab/${tabId}`,
      });
      const logicalPageId = logicalPage.json().page.id as number;
      const session = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "summary-context-secret" },
      });
      const cookie = String(session.headers["set-cookie"]).split(";", 1)[0]!;
      const commandUrl = `/api/local/pages/${logicalPageId}/context/commands`;
      for (const [body, visibility, idempotencyKey] of [
        ["PRIVATE_MODEL_CANARY", "local_only", "summary-private"],
        ["SHAREABLE_ACTIVE_USER_CONTEXT", "share_with_ai", "summary-shareable-active"],
        ["SHAREABLE_WITHDRAWN_CONTEXT", "share_with_ai", "summary-shareable-withdrawn"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: commandUrl,
          headers: { cookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "purpose",
            body,
            visibility,
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(200);
        if (body === "SHAREABLE_WITHDRAWN_CONTEXT") {
          const withdrawn = await app.inject({
            method: "POST",
            url: commandUrl,
            headers: { cookie, "sec-fetch-site": "same-origin" },
            payload: {
              kind: "withdraw",
              entryId: response.json().entry.id,
              idempotencyKey: "summary-shareable-withdraw",
            },
          });
          expect(withdrawn.statusCode).toBe(200);
        }
      }

      for (const [body, idempotencyKey] of [
        ["AGENT_UNREVIEWED_MODEL_CONTEXT", "summary-agent-unreviewed"],
        ["AGENT_REJECTED_MODEL_CONTEXT", "summary-agent-rejected"],
        ["AGENT_ACCEPTED_MODEL_CONTEXT", "summary-agent-accepted"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/agent/pages/${logicalPageId}/context`,
          payload: {
            kind: "append",
            entryKind: "note",
            body,
            provenance: { method: "on_behalf_of_user" },
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(200);
      }
      const context = (
        await app.inject({
          method: "GET",
          url: `/api/local/pages/${logicalPageId}/context`,
          headers: { cookie, "sec-fetch-site": "same-origin" },
        })
      ).json().context;
      const agentEntryId = (body: string) =>
        context.currentEntries.find((entry: { body: string }) => entry.body === body).id as number;
      for (const [body, verdict, idempotencyKey] of [
        ["AGENT_REJECTED_MODEL_CONTEXT", "rejected", "summary-review-rejected"],
        ["AGENT_ACCEPTED_MODEL_CONTEXT", "accepted", "summary-review-accepted"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: commandUrl,
          headers: { cookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "review",
            entryId: agentEntryId(body),
            verdict,
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(200);
      }

      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      await waitForJob(app, queued.json().jobId as number, "succeeded");

      expect(providerContext?.map(({ body }) => body).sort()).toEqual([
        "AGENT_ACCEPTED_MODEL_CONTEXT",
        "SHAREABLE_ACTIVE_USER_CONTEXT",
      ]);
      expect(providerContext).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "SHAREABLE_ACTIVE_USER_CONTEXT",
            state: "active",
            visibility: "share_with_ai",
          }),
          expect.objectContaining({
            body: "AGENT_ACCEPTED_MODEL_CONTEXT",
            reviewVerdict: "accepted",
            state: "active",
            visibility: "share_with_ai",
          }),
        ]),
      );
      expect(JSON.stringify(providerContext)).not.toContain("PRIVATE_MODEL_CANARY");
      expect(JSON.stringify(providerContext)).not.toContain("local_only");
      expect(JSON.stringify(providerContext)).not.toContain("SHAREABLE_WITHDRAWN_CONTEXT");
      expect(JSON.stringify(providerContext)).not.toContain("AGENT_UNREVIEWED_MODEL_CONTEXT");
      expect(JSON.stringify(providerContext)).not.toContain("AGENT_REJECTED_MODEL_CONTEXT");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("omits provider context entirely when the context feature is off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-context-off-"));
    const providerInputs: Array<
      Parameters<SummaryProvider["summarize"]>[0]["context"]
    > = [];
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async (input) => {
        providerInputs.push(input.context);
        return summaryResult("Feature-off summary.");
      },
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      featureFlags: {
        context: false,
        logicalImportance: true,
        priorityShadow: false,
        research: false,
        resources: false,
      },
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "context-projection-off");
      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      await waitForJob(app, queued.json().jobId as number, "succeeded");
      expect(providerInputs).toEqual([undefined]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supersedes an active summary when the requested depth changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-depth-"));
    const pending: Array<{
      depth: "short" | "deep";
      resolve: (result: SummaryJobResult) => void;
    }> = [];
    let cleaningUp = false;
    const provider: SummaryProvider = {
      modelFor: (depth) => `test-${depth}`,
      summarize: async (input) => {
        if (cleaningUp) {
          return summaryResult("Cleanup summary.");
        }

        return new Promise<SummaryJobResult>((resolve) => {
          pending.push({ depth: input.depth, resolve });
        });
      },
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "depth-change");
      const shortResponse = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      const shortJobId = shortResponse.json().jobId as number;
      await waitForJob(app, shortJobId, "running");

      const deepResponse = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "deep" },
      });
      const deepJobId = deepResponse.json().jobId as number;

      expect(deepResponse.statusCode).toBe(202);
      expect(deepJobId).not.toBe(shortJobId);
      await expect(waitForJob(app, shortJobId, "failed")).resolves.toMatchObject(
        { error: expect.stringContaining("Superseded") },
      );

      pending[0]!.resolve(summaryResult("Obsolete short summary."));
      await waitForJob(app, deepJobId, "running");
      expect(pending.map(({ depth }) => depth)).toEqual(["short", "deep"]);

      const beforeDeepResult = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(beforeDeepResult.json().content.summary).toBeNull();

      pending[1]!.resolve(summaryResult("Current deep summary."));
      await expect(waitForJob(app, deepJobId, "succeeded")).resolves.toMatchObject(
        { depth: "deep", result: { summary: "Current deep summary." } },
      );
    } finally {
      cleaningUp = true;
      for (const request of pending) {
        request.resolve(summaryResult("Cleanup summary."));
      }
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supersedes an active summary after content is recaptured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-recapture-"));
    const pending: Array<{
      text: string;
      resolve: (result: SummaryJobResult) => void;
    }> = [];
    let cleaningUp = false;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async (input) => {
        if (cleaningUp) {
          return summaryResult("Cleanup summary.");
        }

        return new Promise<SummaryJobResult>((resolve) => {
          pending.push({ text: input.text, resolve });
        });
      },
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "recaptured-active");
      const originalResponse = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      const originalJobId = originalResponse.json().jobId as number;
      await waitForJob(app, originalJobId, "running");

      await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://example.com/recaptured-active",
          text: "Newer recaptured content.",
          htmlExcerpt: "<article>newer</article>",
        },
      });
      const replacementResponse = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      const replacementJobId = replacementResponse.json().jobId as number;

      expect(replacementResponse.statusCode).toBe(202);
      expect(replacementJobId).not.toBe(originalJobId);
      await expect(
        waitForJob(app, originalJobId, "failed"),
      ).resolves.toMatchObject({ error: expect.stringContaining("Superseded") });

      pending[0]!.resolve(summaryResult("Summary of obsolete content."));
      await waitForJob(app, replacementJobId, "running");
      expect(pending.map(({ text }) => text)).toEqual([
        "Long-form captured content for recaptured-active.",
        "Newer recaptured content.",
      ]);

      const beforeReplacementResult = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(beforeReplacementResult.json().content).toMatchObject({
        text: "Newer recaptured content.",
        summary: null,
      });

      pending[1]!.resolve(summaryResult("Summary of current content."));
      await expect(
        waitForJob(app, replacementJobId, "succeeded"),
      ).resolves.toMatchObject({
        result: { summary: "Summary of current content." },
      });
    } finally {
      cleaningUp = true;
      for (const request of pending) {
        request.resolve(summaryResult("Cleanup summary."));
      }
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched revision without superseding an active matching job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-revision-guard-"));
    let release: ((result: SummaryJobResult) => void) | undefined;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async () => new Promise<SummaryJobResult>((resolve) => {
        release = resolve;
      }),
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "revision-guard");
      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short", expectedContentRevision: 1 },
      });
      expect(queued.statusCode).toBe(202);
      const jobId = queued.json().jobId as number;
      await waitForJob(app, jobId, "running");

      const mismatch = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short", expectedContentRevision: 2 },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({
        error: "TAB_CONTENT_REVISION_MISMATCH",
        expectedContentRevision: 2,
        currentContentRevision: 1,
      });
      const original = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      expect(original.json()).toMatchObject({
        id: jobId,
        status: "running",
        sourceContentRevision: 1,
        contentRevisionMatches: true,
      });
    } finally {
      release?.(summaryResult("Cleanup summary."));
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries transient provider failures and records each attempt cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-retry-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let calls = 0;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      async summarize() {
        calls += 1;
        if (calls === 1) {
          throw new SummaryProviderError("temporary overload", true, 10);
        }
        return summaryResult("Recovered after retry.");
      },
    };
    const app = createApp({
      databasePath,
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "retry");
      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      const jobId = queued.json().jobId as number;
      const completed = await waitForJob(app, jobId, "succeeded");

      expect(completed.attempts).toBe(2);
      expect(calls).toBe(2);

      const database = new Database(databasePath, { readonly: true });
      try {
        const attempts = database
          .prepare(
            `SELECT outcome, cost_usd
             FROM summary_job_attempts
             WHERE job_id = ?
             ORDER BY attempt_no`,
          )
          .all(jobId) as Array<{ outcome: string; cost_usd: number }>;
        expect(attempts).toEqual([
          { outcome: "failed", cost_usd: 0 },
          { outcome: "succeeded", cost_usd: 0.0002 },
        ]);
      } finally {
        database.close();
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a job left running by an interrupted server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-recover-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const clock = () => new Date("2026-08-08T22:00:00.000Z");
    const seedApp = createApp({
      databasePath,
      logger: false,
      clock,
      migrationClock: clock,
    });
    const tabId = await seedCapturedTab(seedApp, "recover");
    await seedApp.close();

    const database = openDatabase(databasePath);
    const catalog = createSummaryCatalog(database.connection, clock);
    const queued = catalog.enqueue(tabId, "short", {
      maxAttempts: 3,
      requestedBy: "user",
      requestedModel: "test-haiku",
    });
    expect(catalog.claimNext(100)).toMatchObject({
      id: queued.jobId,
      attempts: 1,
    });
    database.close();

    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async () => summaryResult("Recovered after restart."),
    };
    const app = createApp({
      databasePath,
      logger: false,
      clock,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });
    try {
      await app.inject({ method: "GET", url: "/api/health" });
      const completed = await waitForJob(app, queued.jobId, "succeeded");
      expect(completed.attempts).toBe(2);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not attach an obsolete summary after content is recaptured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-stale-"));
    let release: ((result: SummaryJobResult) => void) | undefined;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      summarize: async () =>
        new Promise<SummaryJobResult>((resolve) => {
          release = resolve;
        }),
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryWorkerPollMs: 5,
    });

    try {
      const tabId = await seedCapturedTab(app, "stale");
      const queued = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/summarize`,
        payload: { depth: "short" },
      });
      const jobId = queued.json().jobId as number;
      await waitForJob(app, jobId, "running");

      await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://example.com/stale",
          text: "Newer recaptured content.",
          htmlExcerpt: "<article>new</article>",
        },
      });
      release?.(summaryResult("Summary of obsolete content."));

      const failed = await waitForJob(app, jobId, "failed");
      expect(failed.error).toContain("changed during summarization");
      expect(failed).toMatchObject({
        sourceContentRevision: 1,
        currentContentRevision: 2,
        contentRevisionMatches: false,
      });
      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.json().content).toMatchObject({
        text: "Newer recaptured content.",
        summary: null,
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps provider attempts per UTC day without dropping queued work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-limit-"));
    let calls = 0;
    const provider: SummaryProvider = {
      modelFor: () => "test-haiku",
      async summarize(input) {
        calls += 1;
        return summaryResult(`Limited ${input.tabId}`);
      },
    };
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      summaryProvider: provider,
      summaryDailyLimit: 2,
      summaryWorkerPollMs: 5,
    });

    try {
      const ids: number[] = [];
      for (const suffix of ["limit-a", "limit-b", "limit-c"]) {
        ids.push(await seedCapturedTab(app, suffix));
      }
      const jobIds: number[] = [];
      for (const id of ids) {
        const response = await app.inject({
          method: "POST",
          url: `/api/tabs/${id}/summarize`,
          payload: { depth: "short" },
        });
        jobIds.push(response.json().jobId as number);
      }
      await waitForJob(app, jobIds[0]!, "succeeded");
      await waitForJob(app, jobIds[1]!, "succeeded");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const third = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobIds[2]}`,
      });
      expect(third.json().status).toBe("queued");
      expect(third.json().nextAttemptAt).toMatch(/T00:00:00\.000Z$/);
      expect(calls).toBe(2);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "processes 50 requested summaries sequentially and persists their costs",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-summary-bulk-"));
      const databasePath = join(directory, "tabhub.sqlite");
      let active = 0;
      let maxActive = 0;
      const provider: SummaryProvider = {
        modelFor: () => "test-haiku",
        async summarize(input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setImmediate(resolve));
          active -= 1;
          return summaryResult(`BulkMarkerTab${input.tabId}Unique.`);
        },
      };
      const app = createApp({
        databasePath,
        logger: false,
        summaryProvider: provider,
        summaryDailyLimit: 100,
        summaryWorkerPollMs: 5,
      });

      try {
        const tabs = Array.from({ length: 50 }, (_, index) => ({
          url: `https://example.com/bulk-${index}`,
          title: `Bulk ${index}`,
          windowId: 1,
          index,
        }));
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "edge", tabs },
        });
        for (const tab of tabs) {
          await app.inject({
            method: "POST",
            url: "/api/ingest/content",
            payload: {
              browser: "edge",
              url: tab.url,
              text: `Captured bulk text ${tab.index}.`,
              htmlExcerpt: `<article>${tab.index}</article>`,
            },
          });
        }
        const listed = await app.inject({
          method: "GET",
          url: "/api/tabs?pageSize=100",
        });
        const ids = (listed.json().items as Array<{ id: number }>).map(
          ({ id }) => id,
        );
        const jobIds: number[] = [];
        for (const id of ids) {
          const response = await app.inject({
            method: "POST",
            url: `/api/tabs/${id}/summarize`,
            payload: { depth: "short" },
          });
          jobIds.push(response.json().jobId as number);
        }
        await Promise.all(
          jobIds.map((jobId) => waitForJob(app, jobId, "succeeded", 10_000)),
        );

        expect(maxActive).toBe(1);
        const database = new Database(databasePath, { readonly: true });
        try {
          const totals = database
            .prepare(
              `SELECT COUNT(*) AS attempts, SUM(cost_usd) AS cost
               FROM summary_job_attempts`,
            )
            .get() as { attempts: number; cost: number };
          expect(totals.attempts).toBe(50);
          expect(totals.cost).toBeCloseTo(0.01, 8);
        } finally {
          database.close();
        }

        const search = await app.inject({
          method: "GET",
          url: `/api/tabs?q=${encodeURIComponent(
            `BulkMarkerTab${ids[0]}Unique`,
          )}`,
        });
        expect(search.json().total).toBe(1);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
