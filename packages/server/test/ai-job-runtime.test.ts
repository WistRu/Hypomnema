import { describe, expect, it, vi } from "vitest";

import {
  createAiJobRuntime,
  type AiJobRuntimePhysicalAdapter,
} from "../src/ai-job-runtime.js";
import type {
  AiJobClaimBoundary,
  AiJobRuntimeCursor,
} from "../src/ai-job-runtime-state.js";
import type { AiJobScheduleKind } from "../src/ai-job-scheduling.js";

function harness(initialCursor: AiJobRuntimeCursor = 0) {
  let cursor = initialCursor;
  const completed: string[] = [];
  const attempts: Array<{ kind: AiJobScheduleKind; nextCursor: number }> = [];
  const queues: Record<AiJobScheduleKind, string[]> = {
    page_summary: [],
    priority_assessment: [],
    resource_research: [],
  };
  const recoveries: AiJobScheduleKind[] = [];
  const stopped: AiJobScheduleKind[] = [];

  const adapter = (kind: AiJobScheduleKind): AiJobRuntimePhysicalAdapter => ({
    kind,
    recoverInterrupted() {
      recoveries.push(kind);
      return 0;
    },
    claim(boundary: AiJobClaimBoundary) {
      attempts.push({ kind, nextCursor: boundary.nextCursor });
      const id = queues[kind].shift();
      if (id === undefined) return undefined;
      // The fake mirrors the production claim transaction: the cursor and
      // physical claim become visible together, never as a later runtime write.
      cursor = boundary.nextCursor;
      return {
        id,
        async execute() {
          completed.push(id);
        },
      };
    },
    async stop() {
      stopped.push(kind);
    },
  });

  return {
    queues,
    completed,
    attempts,
    recoveries,
    stopped,
    readCursor: () => cursor,
    cursorStore: { read: () => cursor },
    adapter,
  };
}

describe("common durable AI job runtime", () => {
  it("executes the persisted saturated 4:2:1 schedule", async () => {
    const value = harness();
    value.queues.page_summary.push("s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8");
    value.queues.priority_assessment.push("p1", "p2", "p3", "p4");
    value.queues.resource_research.push("r1", "r2");
    const runtime = createAiJobRuntime({
      cursorStore: value.cursorStore,
      adapters: [
        value.adapter("page_summary"),
        value.adapter("priority_assessment"),
        value.adapter("resource_research"),
      ],
    });

    await expect(runtime.drainAvailable()).resolves.toBe(14);
    expect(value.completed).toEqual([
      "s1", "s2", "s3", "s4", "p1", "p2", "r1",
      "s5", "s6", "s7", "s8", "p3", "p4", "r2",
    ]);
    expect(value.readCursor()).toBe(0);
  });

  it("borrows unavailable slots and advances only the successful physical claim", async () => {
    const value = harness(6);
    value.queues.page_summary.push("borrowed-summary");
    const runtime = createAiJobRuntime({
      cursorStore: value.cursorStore,
      adapters: [
        value.adapter("page_summary"),
        value.adapter("priority_assessment"),
        value.adapter("resource_research"),
      ],
    });

    await expect(runtime.drainAvailable()).resolves.toBe(1);
    expect(value.completed).toEqual(["borrowed-summary"]);
    expect(value.readCursor()).toBe(1);
    expect(value.attempts.slice(0, 3)).toEqual([
      { kind: "resource_research", nextCursor: 0 },
      { kind: "page_summary", nextCursor: 1 },
      { kind: "page_summary", nextCursor: 2 },
    ]);
  });

  it("recovers on every start, coalesces drains, and supports stop then restart", async () => {
    const value = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const summary = value.adapter("page_summary");
    const originalClaim = summary.claim.bind(summary);
    summary.claim = (boundary) => {
      const claim = originalClaim(boundary);
      if (claim === undefined || !first) return claim;
      first = false;
      return { ...claim, execute: async () => { await blocked; await claim.execute(); } };
    };
    value.queues.page_summary.push("first");
    const runtime = createAiJobRuntime({
      cursorStore: value.cursorStore,
      adapters: [summary],
      pollMs: 60_000,
    });

    runtime.start();
    const concurrent = runtime.drainAvailable();
    const stopping = runtime.stop();
    release();
    await expect(Promise.all([concurrent, stopping])).resolves.toBeDefined();
    expect(value.recoveries).toEqual(["page_summary"]);
    expect(value.stopped).toEqual(["page_summary"]);

    value.queues.page_summary.push("after-restart");
    runtime.start();
    await runtime.drainAvailable();
    await runtime.stop();
    expect(value.recoveries).toEqual(["page_summary", "page_summary"]);
    expect(value.completed).toEqual(["first", "after-restart"]);
  });

  it("reports execution failure without rewinding the committed cursor", async () => {
    const value = harness();
    value.queues.priority_assessment.push("crash");
    const priority = value.adapter("priority_assessment");
    const originalClaim = priority.claim.bind(priority);
    priority.claim = (boundary) => {
      const claim = originalClaim(boundary);
      return claim === undefined ? undefined : {
        ...claim,
        execute: async () => { throw new Error("simulated execution crash"); },
      };
    };
    const onError = vi.fn();
    const runtime = createAiJobRuntime({
      cursorStore: value.cursorStore,
      adapters: [priority],
      onError,
    });

    await expect(runtime.drainAvailable()).resolves.toBe(1);
    expect(value.readCursor()).toBe(5);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "simulated execution crash",
    }));
  });

  it("reports a physical claim failure without advancing or executing", async () => {
    const value = harness(4);
    const onError = vi.fn();
    const priority = value.adapter("priority_assessment");
    priority.claim = () => { throw new Error("claim transaction failed"); };
    const runtime = createAiJobRuntime({
      cursorStore: value.cursorStore,
      adapters: [priority],
      onError,
    });

    await expect(runtime.drainAvailable()).resolves.toBe(0);
    expect(value.readCursor()).toBe(4);
    expect(value.completed).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "claim transaction failed",
    }));
  });
});
