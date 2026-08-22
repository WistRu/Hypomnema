import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerPriorityRoutes } from "../src/priority-routes.js";
import { createApp } from "../src/app.js";
import type { PriorityAssessmentCoordinator } from
  "../src/priority-assessment-coordinator.js";
import type { LocalCapabilityService } from "../src/local-capability.js";

const at = "2026-08-13T12:00:00.000Z";

function read(subject: { type: "page"; logicalPageId: number } |
  { type: "resource"; resourceId: number }) {
  return {
    subject,
    features: { is_open: true },
    eligibility: { kind: "eligible" as const },
    featureFingerprint: "a".repeat(64),
    ruleset: { rulesetId: 1, version: 1 },
    desiredAssessmentMethod: "rule" as const,
    currentOutcome: null,
    isCurrent: false,
    dirty: true,
    needsReview: false,
  };
}

function localCapabilities(): LocalCapabilityService {
  return {
    authenticate(request) {
      return request.headers.authorization === "Bearer local-test"
        ? { kind: "web" as const, sessionId: "test-session" }
        : null;
    },
  } as LocalCapabilityService;
}

describe("priority route boundaries", () => {
  it("delegates bounded duplicate-preserving reads and one bounded queue query", async () => {
    const calls: Array<{ kind: string; value: unknown }> = [];
    const reader = {
      read(subject: Parameters<PriorityAssessmentCoordinator["read"]>[0]) {
        calls.push({ kind: "read", value: subject });
        return read(subject);
      },
      readBatch(subjects: Parameters<PriorityAssessmentCoordinator["readBatch"]>[0]) {
        calls.push({ kind: "batch", value: subjects });
        return subjects.map(read);
      },
      reviewQueue(input: Parameters<PriorityAssessmentCoordinator["reviewQueue"]>[0]) {
        calls.push({ kind: "queue", value: input });
        return {
          items: [read({ type: "page", logicalPageId: 2 }),
            read({ type: "resource", resourceId: 1 })],
          nextCursor: "opaque-next",
        };
      },
    };
    const app = Fastify();
    registerPriorityRoutes(app, { reader });
    try {
      const subjects = [
        { type: "page" as const, logicalPageId: 7 },
        { type: "page" as const, logicalPageId: 7 },
        { type: "resource" as const, resourceId: 9 },
      ];
      const batch = await app.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch", payload: { subjects } });
      expect(batch.statusCode).toBe(200);
      expect(batch.json().items.map((item: { subject: unknown }) => item.subject))
        .toEqual(subjects);
      expect(batch.json().items[0]).not.toHaveProperty("features");
      expect(calls.filter((call) => call.kind === "batch")).toHaveLength(1);

      for (const [url, subject] of [
        ["/api/logical-pages/7/priority", { type: "page", logicalPageId: 7 }],
        ["/api/resources/9/priority", { type: "resource", resourceId: 9 }],
      ] as const) {
        const single = await app.inject({ method: "GET", url });
        expect(single.statusCode).toBe(200);
        expect(single.json()).toMatchObject({ subject, outcome: null, dirty: true });
        expect(single.json()).not.toHaveProperty("features");
        expect(single.json()).not.toHaveProperty("featureFingerprint");
      }

      const queue = await app.inject({ method: "GET",
        url: "/api/personalization/priority/review-queue?limit=2" });
      expect(queue.statusCode).toBe(200);
      expect(queue.json()).toMatchObject({
        items: [
          { subject: { type: "page", logicalPageId: 2 } },
          { subject: { type: "resource", resourceId: 1 } },
        ],
        nextCursor: "opaque-next",
      });
      expect(calls.filter((call) => call.kind === "queue")).toHaveLength(1);

      const tooLarge = await app.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch", payload: {
          subjects: Array.from({ length: 101 }, (_, index) => ({
            type: "page", logicalPageId: index + 1,
          })),
        } });
      expect(tooLarge.statusCode).toBe(400);
      expect(calls.filter((call) => call.kind === "batch")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("isolates reader and writer surfaces and stamps local/agent provenance", async () => {
    const writes: Array<{ kind: string; value: any }> = [];
    const writer = {
      submit(input: Parameters<PriorityAssessmentCoordinator["submit"]>[0]) {
        writes.push({ kind: "submit", value: input });
        return { id: "priority_assessment:9" as const,
          kind: "priority_assessment" as const, status: "queued" as const };
      },
      recordFeedback(input: Parameters<PriorityAssessmentCoordinator["recordFeedback"]>[0]) {
        writes.push({ kind: "feedback", value: input });
        return {
          id: 11, subject: input.expectedSubject, assessmentId: input.assessmentId,
          verdict: input.verdict, note: input.note ?? null,
          actor: input.provenance.actor, method: input.provenance.method,
          authorizationRef: input.provenance.actor === "agent"
            ? input.provenance.authorizationRef : null,
          idempotencyKey: input.idempotencyKey,
          supersedesId: input.supersedesId ?? null, supersededAt: null,
          revision: 1, createdAt: at,
        };
      },
    };
    const app = Fastify();
    registerPriorityRoutes(app, { capabilities: localCapabilities(), writer });
    try {
      expect((await app.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch", payload: { subjects: [] } }))
        .statusCode).toBe(404);
      expect((await app.inject({ method: "POST",
        url: "/api/personalization/priority/recompute", payload: {
          idempotencyKey: "local-recompute",
        } })).statusCode).toBe(401);

      for (const forbiddenField of [
        "provenance", "features", "fingerprint", "schedulingPriority", "budget",
      ]) {
        const forbidden = await app.inject({ method: "POST",
          url: "/api/personalization/priority/recompute",
          headers: { authorization: "Bearer local-test" }, payload: {
            idempotencyKey: "local-recompute", [forbiddenField]: {},
          } });
        expect(forbidden.statusCode).toBe(400);
      }
      expect(writes).toHaveLength(0);

      const localRecompute = await app.inject({ method: "POST",
        url: "/api/personalization/priority/recompute",
        headers: { authorization: "Bearer local-test" }, payload: {
          subject: { type: "page", logicalPageId: 7 },
          idempotencyKey: "local-recompute",
        } });
      expect(localRecompute.statusCode).toBe(200);
      expect(writes.at(-1)?.value).toMatchObject({
        subject: { type: "page", logicalPageId: 7 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: expect.stringMatching(/^local:[0-9a-f]{64}$/),
      });

      const agentRecompute = await app.inject({ method: "POST",
        url: "/api/agent/personalization/priority/recompute", payload: {
          idempotencyKey: "agent-recompute", authorizationRef: "grant:1",
        } });
      expect(agentRecompute.statusCode).toBe(200);
      expect(writes.at(-1)?.value).toMatchObject({
        subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "agent", requestMethod: "on_behalf_of_user",
          authorizationRef: "grant:1" },
        idempotencyKey: expect.stringMatching(/^agent:[0-9a-f]{64}$/),
      });
      expect(writes.filter((write) => write.kind === "submit")
        .map((write) => write.value.idempotencyKey))
        .toEqual([expect.stringMatching(/^local:[0-9a-f]{64}$/),
          expect.stringMatching(/^agent:[0-9a-f]{64}$/)]);
      expect(writes.every((write) =>
        write.value.idempotencyKey === undefined ||
        Buffer.byteLength(write.value.idempotencyKey, "utf8") <= 200)).toBe(true);

      const localFeedback = await app.inject({ method: "POST",
        url: "/api/logical-pages/7/priority-feedback",
        headers: { authorization: "Bearer local-test" }, payload: {
          assessmentId: 3, verdict: "too_low", idempotencyKey: "local-feedback",
        } });
      expect(localFeedback.statusCode).toBe(200);
      expect(localFeedback.json()).toMatchObject({
        provenance: { actor: "user", method: "manual" },
      });
      expect(localFeedback.json()).not.toHaveProperty("authorizationRef");
      expect(localFeedback.json()).not.toHaveProperty("idempotencyKey");
      expect(writes.at(-1)?.value).toMatchObject({
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: expect.stringMatching(/^local:[0-9a-f]{64}$/),
      });

      const missingAuthorization = await app.inject({ method: "POST",
        url: "/api/agent/resources/4/priority-feedback", payload: {
          assessmentId: 5, verdict: "accept", idempotencyKey: "agent-feedback",
        } });
      expect(missingAuthorization.statusCode).toBe(400);
      const agentFeedback = await app.inject({ method: "POST",
        url: "/api/agent/resources/4/priority-feedback", payload: {
          assessmentId: 5, verdict: "accept", idempotencyKey: "agent-feedback",
          authorizationRef: "grant:2",
        } });
      expect(agentFeedback.statusCode).toBe(200);
      expect(agentFeedback.json()).not.toHaveProperty("authorizationRef");
      expect(agentFeedback.json()).not.toHaveProperty("idempotencyKey");
      expect(writes.at(-1)?.value).toMatchObject({
        expectedSubject: { type: "resource", resourceId: 4 },
        provenance: { actor: "agent", method: "on_behalf_of_user",
          authorizationRef: "grant:2" },
        idempotencyKey: expect.stringMatching(/^agent:[0-9a-f]{64}$/),
      });
    } finally {
      await app.close();
    }
  });

  it("does not expose internal dependency errors in HTTP responses", async () => {
    const app = Fastify();
    registerPriorityRoutes(app, { reader: {
      read() { throw new Error("secret-feature-row-and-query"); },
      readBatch() { throw new Error("secret-feature-row-and-query"); },
      reviewQueue() { throw new Error("secret-feature-row-and-query"); },
    } });
    try {
      const response = await app.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch",
        payload: { subjects: [{ type: "page", logicalPageId: 1 }] } });
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("Priority operation failed");
      expect(response.body).not.toContain("secret-feature-row-and-query");
    } finally {
      await app.close();
    }
  });

  it("wires readers and schema-23 writers as independent default-off capabilities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-routes-"));
    const readerPath = join(directory, "reader.sqlite");
    const commonFlags = {
      activityDailyWriter: false,
      activityWindows: false,
      context: false,
      logicalImportance: false,
      resources: false,
      priorityShadow: false,
      research: false,
    } as const;
    const readerApp = createApp({
      databasePath: readerPath,
      featureFlags: { ...commonFlags, priorityReaders: true, priorityShadow: true,
        priorityAssessmentWriter: false },
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      logger: false,
    });
    try {
      expect((await readerApp.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch", payload: { subjects: [] } }))
        .statusCode).toBe(200);
      expect((await readerApp.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ agentUserImportance: false,
          priorityAssessmentWriter: false, priorityReaders: true,
          priorityShadow: true });
      expect((await readerApp.inject({ method: "POST",
        url: "/api/personalization/priority/recompute", payload: {
          idempotencyKey: "must-not-write",
        } })).statusCode).toBe(404);
      expect((await readerApp.inject({ method: "POST",
        url: "/api/local/session/bootstrap" })).statusCode).toBe(404);
    } finally {
      await readerApp.close();
    }
    const readOnly = new Database(readerPath, { readonly: true });
    try {
      expect(readOnly.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      expect(readOnly.prepare("SELECT COUNT(*) FROM priority_assessments").pluck().get())
        .toBe(0);
      expect(readOnly.prepare(`
        SELECT cursor, updated_at FROM ai_job_runtime_state
      `).get()).toEqual({ cursor: 0, updated_at: at });
    } finally {
      readOnly.close();
    }

    const writerPath = join(directory, "writer.sqlite");
    const writerApp = createApp({
      databasePath: writerPath,
      featureFlags: { ...commonFlags, priorityReaders: false,
        priorityAssessmentWriter: true },
      localDevProxySecret: "priority-writer-secret",
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      logger: false,
    });
    try {
      expect((await writerApp.inject({ method: "POST",
        url: "/api/personalization/priority/read-batch", payload: { subjects: [] } }))
        .statusCode).toBe(404);
      expect((await writerApp.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ agentUserImportance: false,
          priorityAssessmentWriter: true, priorityReaders: false,
          priorityShadow: false });
      const bootstrap = await writerApp.inject({ method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "priority-writer-secret" } });
      expect(bootstrap.statusCode).toBe(204);
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const recompute = await writerApp.inject({ method: "POST",
        url: "/api/personalization/priority/recompute",
        headers: { cookie, "sec-fetch-site": "same-origin" },
        payload: { idempotencyKey: "writer-enabled" } });
      expect(recompute.statusCode).toBe(200);
      expect(recompute.json()).toMatchObject({
        id: expect.stringMatching(/^priority_assessment:/),
        kind: "priority_assessment",
        status: "queued",
      });
      const jobId = Number(String(recompute.json().id).split(":")[1]);
      const writerReader = new Database(writerPath, { readonly: true });
      let status = "queued";
      try {
        const readStatus = writerReader.prepare(`
          SELECT status FROM ai_jobs WHERE id = ? AND kind = 'priority_assessment'
        `).pluck();
        for (let attempt = 0; attempt < 50 && status === "queued"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = String(readStatus.get(jobId));
        }
        expect(status).toBe("succeeded");
        expect(writerReader.prepare(`
          SELECT cursor FROM ai_job_runtime_state
        `).pluck().get()).toBe(5);
        expect(writerReader.prepare(`
          SELECT COUNT(*) FROM ai_job_attempts WHERE outcome = 'succeeded'
        `).pluck().get()).toBe(1);
      } finally {
        writerReader.close();
      }
    } finally {
      await writerApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps every priority surface absent and writes zero rows when all flags are off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-priority-off-"));
    const databasePath = join(directory, "off.sqlite");
    const app = createApp({
      databasePath,
      clock: () => new Date(at),
      migrationClock: () => new Date(at),
      logger: false,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ priorityAssessmentWriter: false, priorityReaders: false,
          priorityShadow: false });
      for (const request of [
        { method: "POST" as const, url: "/api/personalization/priority/read-batch",
          payload: { subjects: [] } },
        { method: "GET" as const, url: "/api/personalization/priority/review-queue" },
        { method: "POST" as const, url: "/api/personalization/priority/recompute",
          payload: { idempotencyKey: "off" } },
        { method: "POST" as const, url: "/api/agent/personalization/priority/recompute",
          payload: { idempotencyKey: "off", authorizationRef: "off" } },
        { method: "GET" as const, url: "/api/ai/jobs/priority_assessment:1" },
      ]) {
        expect((await app.inject(request)).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
    const connection = new Database(databasePath, { readonly: true });
    try {
      expect(connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      expect(connection.prepare("SELECT COUNT(*) FROM priority_assessments").pluck().get())
        .toBe(0);
      expect(connection.prepare("SELECT COUNT(*) FROM priority_feedback").pluck().get())
        .toBe(0);
      expect(connection.prepare("SELECT COUNT(*) FROM resource_priority_feedback")
        .pluck().get()).toBe(0);
    } finally {
      connection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
