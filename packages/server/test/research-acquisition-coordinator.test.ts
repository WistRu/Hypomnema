import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { classifyPublicDnsAnswers, parseRobotsPolicy } from "../src/live-acquisition-policy.js";
import {
  createCompositeResourceResearchAdapter,
  createResearchAcquisitionCoordinator,
  createTrackedC90ClaimExecutor,
  TrackedC90AbortError,
  checkpointC90PersistedTerminalPages,
  checkpointC90TerminalPages,
  executeC90ActionPlan,
  executeC90DynamicActionPlan,
  planC90Recovery,
  selectC90NextPlannedActionId,
} from "../src/research-acquisition-coordinator.js";
import type { AiJobClaim, AiJobLedger } from "../src/ai-job-ledger.js";
import { DurableAiJobError } from "../src/durable-ai-jobs.js";
import type { LiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { openDatabase } from "../src/database.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const at = "2026-08-14T12:00:03.000Z";
const abortRequestDigest = "a".repeat(64);
const actionId = 41;
function executionKeyDigestOf(claim: AiJobClaim): string {
  const leaseTokenDigest = createHash("sha256").update(claim.leaseToken).digest("hex");
  return createHash("sha256").update(
    `tabhub:c90-tracked-execution:v1\0${JSON.stringify({
      jobId: claim.id, attemptId: claim.attemptId,
      attemptNo: claim.attemptNo, leaseTokenDigest,
    })}`,
  ).digest("hex");
}

function installFixtureCourtesy(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  const owner = connection.prepare(`
    SELECT generation.research_run_id AS run_id,
      consent.coordinator_run_generation_id AS run_generation_id
    FROM live_acquisition_consents AS consent
    JOIN privacy_subject_generations AS generation
      ON generation.id = consent.coordinator_run_generation_id
    WHERE consent.id = 1
  `).get() as { run_id: number; run_generation_id: number };
  const originDigest = createHash("sha256")
    .update("https://www.cloudflare.com").digest("hex");
  connection.prepare(`
    INSERT INTO live_acquisition_origin_courtesy_state (
      coordinator_run_id, coordinator_run_generation_id, consent_id,
      canonical_origin_digest, origin_digest, robots_policy_digest, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(owner.run_id, owner.run_generation_id, originDigest, originDigest,
    "8".repeat(64), at);
}

describe("research acquisition coordinator", () => {
  it("selects the live durable frontier robots-first then by depth and UTF-8 URL bytes", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const z = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/z" });
      const a = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/a" });
      const robots = ledger.planRobots({ consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com" });
      expect(selectC90NextPlannedActionId(database.connection, fixture.coordinatorJobId))
        .toBe(robots.id);
      ledger.beginResolution(robots.id);
      ledger.block(robots.id, "POLICY_BLOCKED");
      expect(selectC90NextPlannedActionId(database.connection, fixture.coordinatorJobId))
        .toBe(a.id);
      ledger.beginResolution(a.id);
      ledger.block(a.id, "POLICY_BLOCKED");
      expect(selectC90NextPlannedActionId(database.connection, fixture.coordinatorJobId))
        .toBe(z.id);
    } finally {
      database.close();
    }
  });

  it("reconciles empty, returned-abort, and thrown action plans before stopping", async () => {
    const claim = {
      id: 90,
      kind: "resource_research",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
    } as unknown as AiJobClaim;
    const emptyReconcile = vi.fn((current: AiJobClaim) => current);
    await executeC90ActionPlan({
      claim,
      actionIds: [],
      signal: new AbortController().signal,
      executeAction: vi.fn(),
      reconcile: emptyReconcile,
      renewLease: vi.fn(),
    });
    expect(emptyReconcile).toHaveBeenCalledOnce();

    const returnedController = new AbortController();
    const returnedExecute = vi.fn(async () => { returnedController.abort(); });
    const returnedReconcile = vi.fn((current: AiJobClaim) => current);
    const returnedRenew = vi.fn();
    await executeC90ActionPlan({
      claim,
      actionIds: [1, 2],
      signal: returnedController.signal,
      executeAction: returnedExecute,
      reconcile: returnedReconcile,
      renewLease: returnedRenew,
    });
    expect(returnedExecute).toHaveBeenCalledTimes(1);
    expect(returnedReconcile).toHaveBeenCalledTimes(2);
    expect(returnedRenew).not.toHaveBeenCalled();

    const thrownReconcile = vi.fn((current: AiJobClaim) => current);
    await expect(executeC90ActionPlan({
      claim,
      actionIds: [3],
      signal: new AbortController().signal,
      executeAction: async () => { throw new Error("terminalized-then-thrown"); },
      reconcile: thrownReconcile,
      renewLease: vi.fn(),
    })).rejects.toThrow("terminalized-then-thrown");
    expect(thrownReconcile).toHaveBeenCalledTimes(2);
  });

  it("drains actions admitted by the previous terminal CAS without a fixed snapshot", async () => {
    const claim = {
      id: 90,
      kind: "resource_research",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
    } as unknown as AiJobClaim;
    const durableQueue = [1];
    const executed: number[] = [];
    const reconcile = vi.fn((current: AiJobClaim) => current);
    const renewLease = vi.fn();
    await executeC90DynamicActionPlan({
      claim,
      signal: new AbortController().signal,
      nextActionId: () => durableQueue.shift(),
      executeAction: async (id) => {
        executed.push(id);
        if (id === 1) durableQueue.push(2, 3);
      },
      reconcile,
      renewLease,
    });
    expect(executed).toEqual([1, 2, 3]);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(renewLease).toHaveBeenCalledTimes(2);
  });

  it("fetches a parent, durably admits its child, and selects that child in the same claim", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      let now = new Date("2026-08-14T12:00:00.000Z");
      const actionLedger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => now,
      });
      actionLedger.planRobots({ consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com" });
      actionLedger.planUnknownPage({ consentId: 1,
        url: "https://www.cloudflare.com/parent" });
      const publicResolution = classifyPublicDnsAnswers([
        { address: "104.16.132.229", family: 4 },
      ]);
      if (publicResolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      const requested: string[] = [];
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger,
        client: {
          resolve: async (input) => {
            if (!input.url.endsWith("/robots.txt")) {
              now = new Date(now.getTime() + 2_001);
            }
            const parsed = new URL(input.url);
            return {
              ...publicResolution,
              kind: "resolved" as const,
              canonicalUrl: input.url,
              canonicalOrigin: parsed.origin,
              hostname: parsed.hostname,
              counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 },
            };
          },
          request: async (input) => {
            requested.push(input.canonicalUrl);
            if (input.actionKind === "robots") {
              return {
                kind: "success" as const,
                status: 200 as const,
                selectedIpv4: publicResolution.selectedIpv4,
                answerSetDigest: publicResolution.answerSetDigest,
                body: new TextEncoder().encode("User-agent: TabHubResearch\nDisallow:\n"),
                contentType: "text/plain",
                retryAfter: null,
                usability: null,
                counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 42 },
              };
            }
            const body = new TextEncoder().encode("Useful public evidence. ".repeat(30));
            return {
              kind: "success" as const,
              status: 200 as const,
              selectedIpv4: publicResolution.selectedIpv4,
              answerSetDigest: publicResolution.answerSetDigest,
              body,
              contentType: "text/html",
              retryAfter: null,
              usability: {
                kind: "usable" as const,
                mediaType: "html" as const,
                allVisibleText: new TextDecoder().decode(body),
                primaryText: new TextDecoder().decode(body),
                links: input.canonicalUrl.endsWith("/parent")
                  ? ["https://www.cloudflare.com/child"] : [],
                contentDigest: createHash("sha256").update(body).digest("hex"),
              },
              counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: body.byteLength },
            };
          },
          acquire: async () => { throw new Error("legacy acquire must stay closed"); },
        },
      });
      const claim = {
        id: fixture.coordinatorJobId,
        kind: "resource_research",
        task: { kind: "resource_research",
          workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      } as unknown as AiJobClaim;
      await executeC90DynamicActionPlan({
        claim,
        signal: new AbortController().signal,
        nextActionId: () => selectC90NextPlannedActionId(
          database.connection, fixture.coordinatorJobId),
        executeAction: (id, signal) => coordinator.executeAction(id, signal),
        reconcile: (current) => current,
        renewLease: () => undefined,
      });
      expect(requested).toEqual([
        "https://www.cloudflare.com/robots.txt",
        "https://www.cloudflare.com/parent",
        "https://www.cloudflare.com/child",
      ]);
      expect(selectC90NextPlannedActionId(database.connection, fixture.coordinatorJobId))
        .toBeUndefined();
      expect(database.connection.prepare(`
        SELECT depth, discovered_from_action_id FROM live_acquisition_actions
        WHERE action_kind = 'page' ORDER BY depth, id
      `).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ depth: 1, discovered_from_action_id: expect.any(Number) }),
      ]));
    } finally {
      database.close();
    }
  });

  it("bounds a hostile replenishing frontier at 100 actions", async () => {
    const claim = {
      id: 90,
      kind: "resource_research",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
    } as unknown as AiJobClaim;
    let next = 1;
    const executeAction = vi.fn(async () => undefined);
    await executeC90DynamicActionPlan({
      claim,
      signal: new AbortController().signal,
      nextActionId: () => next++,
      executeAction,
      reconcile: (current) => current,
      renewLease: () => undefined,
    });
    expect(executeAction).toHaveBeenCalledTimes(100);
  });

  it("drains two origins when maxPages=1 and does not replay the budget-exhausted suffix", async () => {
    const claim = {
      id: 90,
      kind: "resource_research",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
    } as unknown as AiJobClaim;
    const queue = [11, 12, 21, 22]; // two robots, then two page reservations
    const terminal = new Set<number>();
    const outcomes = new Map<number, string>();
    const executeAction = vi.fn(async (id: number) => {
      terminal.add(id);
      outcomes.set(id, id === 22 ? "BUDGET_EXHAUSTED" : "FETCH_COMPLETED");
    });
    const nextActionId = () => queue.find((id) => !terminal.has(id));
    await executeC90DynamicActionPlan({
      claim,
      signal: new AbortController().signal,
      nextActionId,
      executeAction,
      reconcile: (current) => current,
      renewLease: () => undefined,
    });
    expect(executeAction.mock.calls.map(([id]) => id)).toEqual([11, 12, 21, 22]);
    expect(outcomes.get(22)).toBe("BUDGET_EXHAUSTED");
    expect(nextActionId()).toBeUndefined();
  });

  it("checkpoints before work, renews between actions, and permits one active attempt per job", async () => {
    const claim = {
      id: 90, kind: "resource_research", attemptId: 900, attemptNo: 1,
      workerId: "tracked-c90", leaseToken: "tracked-c90-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const executeClaim = vi.fn(async (
      _claim: AiJobClaim,
      _signal: AbortSignal,
      control: { renewLease(): boolean },
    ) => {
      order.push("action:1");
      expect(control.renewLease()).toBe(true);
      order.push("action:2");
      await wait;
    });
    const bindAttemptProvider = vi.fn();
    const recordAttemptRequest = vi.fn();
    const checkpoint = vi.fn(() => {
      order.push("checkpoint");
      return { status: "running" };
    });
    const renew = vi.fn(() => ({ ...claim, leaseExpiresAt: "2026-08-14T12:02:00.000Z" }));
    const onSettled = vi.fn();
    const executor = createTrackedC90ClaimExecutor({
      ledger: { bindAttemptProvider, recordAttemptRequest, checkpoint, renew } as unknown as AiJobLedger,
      executeClaim,
      onSettled,
    });

    expect(executor.runTrackedClaim(claim)).toBeUndefined();
    executor.runTrackedClaim(claim);
    await Promise.resolve();
    expect(executeClaim).toHaveBeenCalledOnce();
    expect(executor.activeCount()).toBe(1);
    expect(order).toEqual(["checkpoint", "action:1", "action:2"]);
    expect(renew).toHaveBeenCalledOnce();
    expect(bindAttemptProvider).not.toHaveBeenCalled();
    expect(recordAttemptRequest).not.toHaveBeenCalled();
    expect(() => executor.runTrackedClaim({
      ...claim,
      attemptId: 901,
      attemptNo: 2,
      leaseToken: "tracked-c90-conflicting-lease",
    })).toThrowError(expect.objectContaining({ code: "JOB_ACTIVE_CONFLICT" }));
    release();
    await executor.stop();
    expect(executor.activeCount()).toBe(0);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("signals the exact tracked claim and acknowledges only after its operation unwinds", async () => {
    const claim = {
      id: 190, kind: "resource_research", attemptId: 1900, attemptNo: 2,
      workerId: "tracked-c90-abort", leaseToken: "tracked-c90-abort-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const order: string[] = [];
    let observedAbortReason: unknown;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let unwind!: () => void;
    const unwindPromise = new Promise<void>((resolve) => { unwind = resolve; });
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          observedAbortReason = signal.reason;
          order.push("signalled");
          resolve();
        }, { once: true }));
        await unwindPromise;
        order.push("unwound");
      },
      onSettled: () => { order.push("removed"); },
    });
    executor.runTrackedClaim(claim);
    await enteredPromise;
    const leaseTokenDigest = createHash("sha256").update(claim.leaseToken).digest("hex");
    const acknowledgementPromise = executor.abortAndWait({
      actionId,
      jobId: claim.id,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest,
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    });
    await Promise.resolve();
    expect(order).toEqual(["signalled"]);
    expect(observedAbortReason).toEqual({
      kind: "privacy_purge",
      requestDigest: abortRequestDigest,
      actionId,
      executionKeyDigest: executionKeyDigestOf(claim),
    });
    expect(executor.activeCount()).toBe(1);
    await expect(executor.abortAndWait({
      actionId,
      jobId: claim.id,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest,
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    })).rejects.toEqual(expect.objectContaining({ code: "C90_ABORT_ALREADY_REQUESTED" }));
    unwind();
    const acknowledgement = await acknowledgementPromise;
    order.push("acknowledged");
    expect(order).toEqual(["signalled", "unwound", "removed", "acknowledged"]);
    expect(acknowledgement).toMatchObject({
      status: "acknowledged",
      jobId: claim.id,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest,
      signalled: true,
      settled: true,
      settlement: "fulfilled",
    });
    expect(acknowledgement.status).toBe("acknowledged");
    if (acknowledgement.status !== "acknowledged") throw new Error("expected abort ack");
    expect(acknowledgement.executionKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(acknowledgement.acknowledgementDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(acknowledgement)).toBe(true);
    expect(executor.activeCount()).toBe(0);
  });

  it("fails closed on identity mismatch without signalling unrelated claims", async () => {
    const base = {
      kind: "resource_research", attemptNo: 1, workerId: "tracked-c90-exact",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    };
    const first = { ...base, id: 191, attemptId: 1910,
      leaseToken: "tracked-c90-exact-first" } as unknown as AiJobClaim;
    const second = { ...base, id: 192, attemptId: 1920,
      leaseToken: "tracked-c90-exact-second" } as unknown as AiJobClaim;
    const aborted: number[] = [];
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (claim, signal) => new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          aborted.push(claim.id);
          resolve();
        }, { once: true })),
    });
    executor.runTrackedClaim(first);
    executor.runTrackedClaim(second);
    await Promise.resolve();
    const digestOf = (claim: AiJobClaim) => createHash("sha256")
      .update(claim.leaseToken).digest("hex");
    await expect(executor.abortAndWait({
      actionId,
      jobId: first.id,
      attemptId: first.attemptId + 1,
      attemptNo: first.attemptNo,
      leaseTokenDigest: digestOf(first),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(first),
    })).rejects.toEqual(expect.objectContaining({ code: "C90_EXECUTION_IDENTITY_MISMATCH" }));
    expect(aborted).toEqual([]);
    expect(executor.activeCount()).toBe(2);
    await executor.abortAndWait({
      actionId,
      jobId: first.id, attemptId: first.attemptId, attemptNo: first.attemptNo,
      leaseTokenDigest: digestOf(first),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(first),
    });
    expect(aborted).toEqual([first.id]);
    expect(executor.activeCount()).toBe(1);
    await executor.abortAndWait({
      actionId,
      jobId: second.id, attemptId: second.attemptId, attemptNo: second.attemptNo,
      leaseTokenDigest: digestOf(second),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(second),
    });
    expect(aborted).toEqual([first.id, second.id]);
  });

  it("carries exact abort provenance through the real tracked executor and coordinator", async () => {
    const claim = {
      id: 198, kind: "resource_research", attemptId: 1980, attemptNo: 1,
      workerId: "tracked-c90-real-bridge", leaseToken: "tracked-c90-real-bridge-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    let state = "planned";
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const blockForPrivacyPurgeAbort = vi.fn((_id, provenance) => {
      state = "ambiguous";
      expect(provenance).toEqual({
        requestDigest: abortRequestDigest,
        executionKeyDigest: executionKeyDigestOf(claim),
      });
    });
    const coordinator = createResearchAcquisitionCoordinator({
      actionLedger: {
        read: () => ({ id: actionId, state, exact_url: "https://example.com/",
          expires_at: "2026-08-21T13:00:00.000Z", action_kind: "page" }),
        beginResolution: () => { state = "resolution_started"; },
        recordResolution: () => { state = "resolved"; },
        authorize: () => ({ expiresAt: "2026-08-21T13:00:00.000Z" }),
        reserveRequest: vi.fn(),
        start: () => { state = "started"; },
        block: vi.fn(),
        blockForPrivacyPurgeAbort,
      } as unknown as LiveAcquisitionActionLedger,
      client: {
        resolve: async () => ({ kind: "resolved" as const,
          canonicalUrl: "https://example.com/", canonicalOrigin: "https://example.com",
          hostname: "example.com", selectedIpv4: "93.184.216.34",
          answerSetDigest: "4".repeat(64), normalizedAnswers: ["93.184.216.34"],
          selectedIpv4Digest: "5".repeat(64) }),
        request: async ({ signal }: { signal?: AbortSignal }) => {
          entered();
          await new Promise<void>((_resolve, reject) => signal?.addEventListener(
            "abort", () => reject(new Error("aborted")), { once: true },
          ));
          throw new Error("unreachable");
        },
      } as never,
    });
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => coordinator.executeAction(actionId, signal),
    });
    executor.runTrackedClaim(claim);
    await enteredPromise;
    await expect(executor.abortAndWait({
      actionId, jobId: claim.id, attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      executionKeyDigest: executionKeyDigestOf(claim), abortRequestDigest,
    })).resolves.toMatchObject({ status: "acknowledged", abortRequestDigest });
    expect(blockForPrivacyPurgeAbort).toHaveBeenCalledOnce();
  });

  it("distinguishes response-won settlement, acknowledged replay, and unknown execution", async () => {
    const claim = {
      id: 193, kind: "resource_research", attemptId: 1930, attemptNo: 1,
      workerId: "tracked-c90-settled", leaseToken: "tracked-c90-settled-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const settled: Array<() => void> = [];
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async () => undefined,
      onSettled: () => { settled.shift()?.(); },
    });
    const identity = {
      actionId,
      jobId: claim.id, attemptId: claim.attemptId, attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    };
    const responseWon = new Promise<void>((resolve) => settled.push(resolve));
    executor.runTrackedClaim(claim);
    await responseWon;
    await expect(executor.abortAndWait(identity)).resolves.toMatchObject({
      status: "already_settled",
      signalled: false,
      settled: true,
      terminalOutcome: "settled_without_abort",
    });

    let abortEntered!: () => void;
    const abortEnteredPromise = new Promise<void>((resolve) => { abortEntered = resolve; });
    const aborting = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => {
        abortEntered();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    aborting.runTrackedClaim(claim);
    await abortEnteredPromise;
    await aborting.abortAndWait(identity);
    await expect(aborting.abortAndWait(identity)).resolves.toMatchObject({
      status: "already_settled",
      terminalOutcome: "settled_after_external_abort",
      signalled: false,
    });
    await expect(aborting.abortAndWait({ ...identity, jobId: 999_999 }))
      .rejects.toBeInstanceOf(TrackedC90AbortError);
  });

  it("treats the response-won microtask gap as already settled without signalling", async () => {
    const claim = {
      id: 195, kind: "resource_research", attemptId: 1950, attemptNo: 1,
      workerId: "tracked-c90-response-gap", leaseToken: "tracked-c90-response-gap-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => { resolveOperation = resolve; });
    let observedSignal: AbortSignal | undefined;
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => {
        observedSignal = signal;
        await operation;
      },
    });
    executor.runTrackedClaim(claim);
    await Promise.resolve();
    resolveOperation();
    await Promise.resolve();
    await Promise.resolve();
    expect(executor.activeCount()).toBe(1);
    const result = await executor.abortAndWait({
      actionId,
      jobId: claim.id, attemptId: claim.attemptId, attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    });
    expect(result).toMatchObject({
      status: "already_settled",
      terminalOutcome: "settled_without_abort",
      signalled: false,
      settled: true,
    });
    expect(observedSignal?.aborted).toBe(false);
  });

  it("snapshots hostile abort input getters exactly once before lookup", async () => {
    const claim = {
      id: 196, kind: "resource_research", attemptId: 1960, attemptNo: 1,
      workerId: "tracked-c90-hostile", leaseToken: "tracked-c90-hostile-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })),
    });
    executor.runTrackedClaim(claim);
    await Promise.resolve();
    const reads = new Map<string, number>();
    const values = {
      actionId,
      jobId: claim.id,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    };
    const hostile = Object.fromEntries(Object.entries(values).map(([name, value]) => [
      name,
      { enumerable: true, get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      } },
    ]));
    const input = Object.defineProperties({}, hostile) as typeof values;
    await expect(executor.abortAndWait(input)).resolves.toMatchObject({
      status: "acknowledged",
    });
    expect(Object.fromEntries(reads)).toEqual({
      actionId: 1, jobId: 1, attemptId: 1, attemptNo: 1,
      leaseTokenDigest: 1, abortRequestDigest: 1, executionKeyDigest: 1,
    });

    const throwing = Object.defineProperty({}, "jobId", {
      get() { throw new Error("hostile getter"); },
    }) as typeof values;
    await expect(executor.abortAndWait(throwing)).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_C90_ABORT_REQUEST" }),
    );
  });

  it("does not let a throwing settlement observer suppress abort acknowledgement", async () => {
    const claim = {
      id: 197, kind: "resource_research", attemptId: 1970, attemptNo: 1,
      workerId: "tracked-c90-observer", leaseToken: "tracked-c90-observer-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })),
      onSettled: () => { throw new Error("observer failed"); },
    });
    executor.runTrackedClaim(claim);
    await Promise.resolve();
    await expect(executor.abortAndWait({
      actionId,
      jobId: claim.id, attemptId: claim.attemptId, attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    })).resolves.toMatchObject({
      status: "acknowledged", signalled: true, settled: true,
    });
    expect(executor.activeCount()).toBe(0);
  });

  it("fails closed after a settled execution is evicted from the bounded cache", async () => {
    const base = {
      kind: "resource_research", attemptNo: 1, workerId: "tracked-c90-eviction",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    };
    const waiters: Array<() => void> = [];
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async () => undefined,
      onSettled: () => { waiters.shift()?.(); },
    });
    const claims: AiJobClaim[] = [];
    for (let index = 0; index < 257; index += 1) {
      const claim = { ...base, id: 20_000 + index, attemptId: 30_000 + index,
        leaseToken: `tracked-c90-eviction-${index}` } as unknown as AiJobClaim;
      claims.push(claim);
      const settled = new Promise<void>((resolve) => waiters.push(resolve));
      executor.runTrackedClaim(claim);
      await settled;
    }
    const requestOf = (claim: AiJobClaim) => ({
      actionId,
      jobId: claim.id, attemptId: claim.attemptId, attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    });
    await expect(executor.abortAndWait(requestOf(claims[0]!))).rejects.toEqual(
      expect.objectContaining({ code: "C90_EXECUTION_NOT_ACTIVE" }),
    );
    await expect(executor.abortAndWait(requestOf(claims.at(-1)!))).resolves.toMatchObject({
      status: "already_settled", terminalOutcome: "settled_without_abort",
    });
  });

  it("fails closed when stop already signalled the active execution", async () => {
    const claim = {
      id: 194, kind: "resource_research", attemptId: 1940, attemptNo: 1,
      workerId: "tracked-c90-stop-race", leaseToken: "tracked-c90-stop-race-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const executor = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(),
          { once: true }));
        await releasePromise;
      },
    });
    executor.runTrackedClaim(claim);
    await enteredPromise;
    const stopping = executor.stop();
    await expect(executor.abortAndWait({
      actionId,
      jobId: claim.id, attemptId: claim.attemptId, attemptNo: claim.attemptNo,
      leaseTokenDigest: createHash("sha256").update(claim.leaseToken).digest("hex"),
      abortRequestDigest,
      executionKeyDigest: executionKeyDigestOf(claim),
    })).rejects.toEqual(expect.objectContaining({ code: "C90_EXECUTION_ALREADY_ABORTED" }));
    release();
    await stopping;
  });

  it("preserves typed terminal failures and aborts/awaits stop", async () => {
    const claim = {
      id: 91, kind: "resource_research", attemptId: 901, attemptNo: 1,
      workerId: "tracked-c90-failure", leaseToken: "tracked-c90-failure-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const fail = vi.fn(() => ({}));
    let settled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { settled = resolve; });
    const executor = createTrackedC90ClaimExecutor({
      ledger: {
        checkpoint: vi.fn(() => ({ status: "running" })),
        refresh: vi.fn(() => claim),
        fail,
      } as unknown as AiJobLedger,
      executeClaim: async () => {
        throw new DurableAiJobError("JOB_BUDGET_EXHAUSTED", "c90-budget");
      },
      onSettled: () => { settled(); },
    });
    executor.runTrackedClaim(claim);
    await settledPromise;
    expect(fail).toHaveBeenCalledWith(claim, {
      progress: { completed: 0, total: 1, stage: "claimed" },
      checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    }, { code: "JOB_BUDGET_EXHAUSTED" });

    let aborted = false;
    const stopping = createTrackedC90ClaimExecutor({
      ledger: { checkpoint: vi.fn(() => ({ status: "running" })) } as unknown as AiJobLedger,
      executeClaim: async (_claim, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true }));
      },
    });
    stopping.runTrackedClaim({ ...claim, attemptId: 902,
      leaseToken: "tracked-c90-stop-lease" });
    await Promise.resolve();
    await stopping.stop();
    expect(aborted).toBe(true);
    expect(stopping.activeCount()).toBe(0);
  });

  it("maps an untyped execution failure to a deterministic retry, then terminal failure", async () => {
    const baseClaim = {
      id: 92, kind: "resource_research", attemptId: 920, attemptNo: 1,
      workerId: "tracked-c90-retry", leaseToken: "tracked-c90-retry-lease",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" }, checkpoint: null,
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const failures: unknown[] = [];
    const settled: Array<() => void> = [];
    const ledger = {
      checkpoint: vi.fn(() => ({ status: "running" })),
      refresh: vi.fn((claim: AiJobClaim) => claim),
      fail: vi.fn((_claim: AiJobClaim, _checkpoint: unknown, failure: unknown) => {
        failures.push(failure);
        return {};
      }),
    } as unknown as AiJobLedger;
    const executor = createTrackedC90ClaimExecutor({
      ledger,
      clock: () => new Date(at),
      executeClaim: async () => { throw new Error("temporary acquisition failure"); },
      onSettled: () => { settled.shift()?.(); },
    });
    const waitForSettlement = () => new Promise<void>((resolve) => settled.push(resolve));

    const firstSettled = waitForSettlement();
    executor.runTrackedClaim(baseClaim);
    await firstSettled;
    const finalSettled = waitForSettlement();
    executor.runTrackedClaim({ ...baseClaim, attemptId: 922, attemptNo: 3,
      leaseToken: "tracked-c90-final-lease" });
    await finalSettled;

    expect(failures).toEqual([
      { code: "JOB_INPUT_UNAVAILABLE", retryAt: "2026-08-14T12:00:04.000Z" },
      { code: "JOB_INPUT_UNAVAILABLE" },
    ]);
  });
  it("charges exactly one generic step per newly terminal reserved page", () => {
    let claim = {
      id: 90,
      kind: "resource_research",
      attemptId: 900,
      attemptNo: 1,
      workerId: "c90-step-test",
      leaseToken: "c90-step-lease",
      leaseExpiresAt: "2026-08-14T12:01:00.000Z",
      task: { kind: "resource_research",
        workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      progress: { completed: 0, total: 1, stage: "claimed" },
      checkpoint: null,
      usage: { steps: 2, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    } as unknown as AiJobClaim;
    const checkpoints: unknown[] = [];
    const ledger = {
      checkpoint(received: AiJobClaim, input: unknown) {
        expect(received).toBe(claim);
        checkpoints.push(input);
        return {};
      },
      refresh() {
        claim = { ...claim, checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: { ...claim.usage, steps: 3 } };
        return claim;
      },
    } as unknown as AiJobLedger;

    expect(checkpointC90TerminalPages(ledger, claim, 3)).toBe(claim);
    expect(checkpoints).toEqual([{
      progress: { completed: 0, total: 1, stage: "claimed" },
      checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
      usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    }]);
    expect(checkpointC90TerminalPages(ledger, claim, 3)).toBe(claim);
    expect(checkpoints).toHaveLength(1);
    expect(() => checkpointC90TerminalPages(ledger, claim, 51)).toThrow(/terminal page count/i);
  });

  it("derives the generic C90 page charge from persisted reserved terminal page actions", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const actionLedger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const robots = actionLedger.planRobots({
        consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com",
      });
      actionLedger.beginResolution(robots.id);
      const robotsResolution = classifyPublicDnsAnswers([
        { address: "104.16.132.229", family: 4 },
      ]);
      if (robotsResolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      actionLedger.recordResolution(robots.id, robotsResolution);
      actionLedger.authorize(robots.id);
      actionLedger.start(robots.id);
      const robotsText = "User-agent: TabHubResearch\nDisallow:\n";
      const robotsPolicy = parseRobotsPolicy(robotsText);
      if (robotsPolicy.kind !== "parsed") throw new Error("fixture robots policy rejected");
      actionLedger.completeRobots(robots.id, {
        policyDigest: robotsPolicy.policyDigest,
        crawlDelayMs: robotsPolicy.crawlDelayMs,
        policyText: robotsText,
      });
      const dnsBlocked = actionLedger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/reserved-before-dns",
      });
      actionLedger.beginResolution(dnsBlocked.id);
      actionLedger.block(dnsBlocked.id, "TRANSPORT_DNS_FAILURE");
      expect(database.connection.prepare(`
        SELECT action.id, action.state, reservation.id AS reservation_id
        FROM live_acquisition_actions AS action
        LEFT JOIN live_acquisition_page_reservations AS reservation
          ON reservation.action_id = action.id
        WHERE action.consent_id = 1 AND action.action_kind = 'page'
        ORDER BY action.id
      `).all()).toEqual([
        { id: 7001, state: "completed", reservation_id: 1 },
        { id: dnsBlocked.id, state: "blocked", reservation_id: 2 },
      ]);
      let claim = {
        id: fixture.coordinatorJobId,
        kind: "resource_research",
        attemptId: 900,
        attemptNo: 1,
        workerId: "persisted-page-counter",
        leaseToken: "persisted-page-counter-lease",
        task: { kind: "resource_research",
          workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
        progress: { completed: 0, total: 1, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      } as unknown as AiJobClaim;
      const checkpoint = vi.fn(() => ({}));
      const ledger = {
        checkpoint,
        refresh() {
          claim = { ...claim, usage: { ...claim.usage, steps: 2 } };
          return claim;
        },
      } as unknown as AiJobLedger;

      expect(checkpointC90PersistedTerminalPages(
        database.connection,
        ledger,
        claim,
      ).usage.steps).toBe(2);
      expect(checkpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        usage: { steps: 2, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      }));
    } finally {
      database.close();
    }
  });

  it("does not begin or start a C90 action after cancellation", async () => {
    const controller = new AbortController();
    const calls = {
      beginResolution: vi.fn(),
      recordResolution: vi.fn(),
      authorize: vi.fn(() => ({ expiresAt: "2026-08-14T12:05:00.000Z" })),
      reserveRequest: vi.fn(),
      start: vi.fn(),
    };
    const actionLedger = {
      read: () => ({ id: 41, state: "planned", action_kind: "page",
        exact_url: "https://www.cloudflare.com/aborted",
        expires_at: "2026-08-14T12:05:00.000Z" }),
      ...calls,
    } as unknown as LiveAcquisitionActionLedger;
    const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
    if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
    const coordinator = createResearchAcquisitionCoordinator({
      actionLedger,
      client: {
        resolve: async () => {
          controller.abort();
          return { ...resolution, kind: "resolved" as const,
            canonicalUrl: "https://www.cloudflare.com/aborted",
            canonicalOrigin: "https://www.cloudflare.com", hostname: "www.cloudflare.com",
            counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 } };
        },
        request: async () => { throw new Error("request must not run after cancellation"); },
        acquire: async () => { throw new Error("acquire must not run"); },
      },
    });

    await coordinator.executeAction(41, controller.signal);
    expect(calls.beginResolution).toHaveBeenCalledOnce();
    expect(calls.recordResolution).not.toHaveBeenCalled();
    expect(calls.reserveRequest).not.toHaveBeenCalled();
    expect(calls.start).not.toHaveBeenCalled();
  });

  it.each([
    [{ attemptNo: 1, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 0, capturedPages: 1, ambiguousActions: 0 },
    { kind: "handoff_ready" }],
    [{ attemptNo: 1, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 1, capturedPages: 0, ambiguousActions: 0 },
    { kind: "reconsent_required", networkActions: 0, reuseCapturedMaterial: false }],
    [{ attemptNo: 2, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 1, capturedPages: 1, ambiguousActions: 0 },
    { kind: "reconsent_required", networkActions: 0, reuseCapturedMaterial: true }],
    [{ attemptNo: 3, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 1, capturedPages: 0, ambiguousActions: 0 },
    { kind: "terminal", code: "BUDGET_EXHAUSTED" }],
    [{ attemptNo: 1, maxAttempts: 3, wallBudgetRemaining: false,
      remainingNeverStartedPlanned: 1, capturedPages: 0, ambiguousActions: 0 },
    { kind: "terminal", code: "BUDGET_EXHAUSTED" }],
    [{ attemptNo: 1, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 0, capturedPages: 0, ambiguousActions: 0 },
    { kind: "terminal", code: "NO_ELIGIBLE_SOURCE" }],
    [{ attemptNo: 1, maxAttempts: 3, wallBudgetRemaining: true,
      remainingNeverStartedPlanned: 0, capturedPages: 1, ambiguousActions: 1 },
    { kind: "terminal", code: "WORKFLOW_AMBIGUOUS" }],
  ] as const)("plans no-network recovery without replay %#", (input, expected) => {
    expect(planC90Recovery(input)).toEqual(expected);
  });

  it("executes robots through the phased ledger and returns to the runtime immediately", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date("2026-08-14T12:00:00.000Z") });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => new Date(at) });
      const action = ledger.planRobots({ consentId: 1, canonicalOrigin: "https://www.cloudflare.com" });
      const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve: async () => {
            expect(database.connection.inTransaction).toBe(false);
            return {
              ...resolution,
              kind: "resolved" as const,
              canonicalUrl: action.canonicalUrl,
              canonicalOrigin: action.canonicalOrigin,
              hostname: "www.cloudflare.com",
              counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 },
            };
          },
          request: async () => {
            expect(database.connection.inTransaction).toBe(false);
            await wait;
            return {
              kind: "success" as const,
              status: 200 as const,
              selectedIpv4: resolution.selectedIpv4,
              answerSetDigest: resolution.answerSetDigest,
              body: new TextEncoder().encode("User-agent: TabHubResearch\nDisallow:\n"),
              contentType: "text/plain",
              retryAfter: null,
              usability: null,
              counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 120 },
            };
          },
          acquire: async () => { throw new Error("closed coordinator uses phased client"); },
        },
      });
      expect(coordinator.runTracked(action.id)).toBeUndefined();
      expect(coordinator.activeCount()).toBe(1);
      release();
      await vi.waitFor(() => expect(ledger.read(action.id).state).toBe("completed"));
      await coordinator.stop();
      expect(coordinator.activeCount()).toBe(0);
      expect(ledger.read(action.id).state).toBe("completed");
    } finally {
      database.close();
    }
  });

  it("terminalizes a current DNS failure as blocked rather than ambiguous", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date("2026-08-14T12:00:00.000Z") });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => new Date(at) });
      const action = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/dns-failure" });
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve: async () => ({
            kind: "blocked" as const,
            code: "TRANSPORT_DNS_FAILURE" as const,
            counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 },
          }),
          request: async () => { throw new Error("request must not run"); },
          acquire: async () => { throw new Error("acquire must not run"); },
        },
      });

      await coordinator.executeAction(action.id);
      expect(ledger.read(action.id).state).toBe("blocked");
      expect(database.connection.prepare(`
        SELECT outcome_code FROM live_acquisition_action_events
        WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get(action.id)).toBe("TRANSPORT_DNS_FAILURE");
    } finally {
      database.close();
    }
  });

  it("terminalizes an expired never-started action without DNS and never reselects it", async () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      let now = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const action = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/expires-before-resolution" });
      now = new Date("2026-08-14T12:06:00.000Z");
      const resolve = vi.fn(async () => { throw new Error("DNS must stay closed"); });
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve,
          request: async () => { throw new Error("request must stay closed"); },
          acquire: async () => { throw new Error("legacy acquire must stay closed"); },
        },
      });
      await coordinator.executeAction(action.id);
      expect(resolve).not.toHaveBeenCalled();
      expect(ledger.read(action.id).state).toBe("blocked");
      expect(database.connection.prepare(`
        SELECT outcome_code FROM live_acquisition_action_events
        WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get(action.id)).toBe("CANCELLED");
      expect(selectC90NextPlannedActionId(database.connection, 7_001)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("blocks ruleset drift before DNS with the exact Resource-membership outcome", async () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const action = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/drift-before-dns",
      });
      database.connection.exec(`
        INSERT INTO resource_match_rules (
          id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
          priority, provenance_class, created_by, creation_method, created_at
        ) VALUES (77999, 'post-consent-drift', 1, 7001, 'drift.cloudflare.com',
          'exact_host', '/', 1, 'system_seed', 'system', 'derived', '${at}');
        INSERT INTO resource_match_rule_heads (rule_key, rule_id)
        VALUES ('post-consent-drift', 77999);
      `);
      const resolve = vi.fn(async () => { throw new Error("DNS must stay closed"); });
      const request = vi.fn(async () => { throw new Error("GET must stay closed"); });
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve,
          request,
          acquire: async () => { throw new Error("legacy acquire must stay closed"); },
        },
      });

      await coordinator.executeAction(action.id);
      expect(resolve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(ledger.read(action.id).state).toBe("blocked");
      expect(database.connection.prepare(`
        SELECT outcome_code FROM live_acquisition_action_events
        WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get(action.id)).toBe("ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH");
    } finally {
      database.close();
    }
  });

  it("rechecks exact page membership at start and never issues GET after drift", async () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureCourtesy(database.connection);
      const realPreview = createResourceCatalog(database.connection).previewResourceUrl;
      let previews = 0;
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
        previewResourceUrl(url, version) {
          previews += 1;
          return previews < 6
            ? realPreview(url, version)
            : {
                kind: "unmatched" as const,
                rulesetVersion: version,
                rulesetResourceGenerationFingerprint: "0".repeat(64),
              };
        },
      });
      const action = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/drift-before-get",
      });
      const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      const resolve = vi.fn(async () => ({
        ...resolution,
        kind: "resolved" as const,
        canonicalUrl: action.canonicalUrl,
        canonicalOrigin: action.canonicalOrigin,
        hostname: "www.cloudflare.com",
        counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 },
      }));
      const request = vi.fn(async () => { throw new Error("GET must stay closed"); });
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve,
          request,
          acquire: async () => { throw new Error("legacy acquire must stay closed"); },
        },
      });

      await coordinator.executeAction(action.id);
      expect(previews).toBe(6);
      expect(resolve).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      expect(ledger.read(action.id).state).toBe("blocked");
      expect(database.connection.prepare(`
        SELECT outcome_code FROM live_acquisition_action_events
        WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get(action.id)).toBe("ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_page_reservations WHERE action_id = ?
      `).pluck().get(action.id)).toBe(1);
    } finally {
      database.close();
    }
  });

  it.each(["returned", "thrown"] as const)(
    "terminalizes an abort-%s request after start as ambiguous CANCELLED",
    async (mode) => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureCourtesy(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const action = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: `https://www.cloudflare.com/abort-${mode}`,
      });
      const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      const controller = new AbortController();
      const coordinator = createResearchAcquisitionCoordinator({
        actionLedger: ledger,
        client: {
          resolve: async () => ({ ...resolution, kind: "resolved" as const,
            canonicalUrl: action.canonicalUrl, canonicalOrigin: action.canonicalOrigin,
            hostname: "www.cloudflare.com",
            counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 } }),
          request: async () => {
            controller.abort();
            if (mode === "thrown") throw new Error("aborted fetch");
            return {
              kind: "blocked" as const,
              code: "TRANSPORT_TIMEOUT" as const,
              retryAfter: null,
              counters: { dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 0 },
            };
          },
          acquire: async () => { throw new Error("legacy acquire must stay closed"); },
        },
      });

      await coordinator.executeAction(action.id, controller.signal);
      expect(ledger.read(action.id).state).toBe("ambiguous");
      expect(database.connection.prepare(`
        SELECT outcome_code FROM live_acquisition_action_events
        WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get(action.id)).toBe("CANCELLED");
    } finally {
      database.close();
    }
    },
  );

  it("passes a page Retry-After header to the durable action terminalization", async () => {
    const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
    if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
    const blocks: unknown[][] = [];
    const actionLedger = {
      read: () => ({ id: 41, state: "planned", action_kind: "page",
        exact_url: "https://www.cloudflare.com/rate-limited",
        expires_at: "2026-08-14T12:05:00.000Z" }),
      beginResolution: () => undefined,
      recordResolution: () => undefined,
      authorize: () => ({ authorizationDigest: "a".repeat(64),
        expiresAt: "2026-08-14T12:00:15.000Z" }),
      reserveRequest: () => undefined,
      start: () => undefined,
      block: (...args: unknown[]) => { blocks.push(args); },
    } as unknown as LiveAcquisitionActionLedger;
    const coordinator = createResearchAcquisitionCoordinator({
      actionLedger,
      client: {
        resolve: async () => ({ ...resolution, kind: "resolved" as const,
          canonicalUrl: "https://www.cloudflare.com/rate-limited",
          canonicalOrigin: "https://www.cloudflare.com", hostname: "www.cloudflare.com",
          counters: { dnsCalls: 1, connectAttempts: 0, httpApplicationBytes: 0 } }),
        request: async () => ({ kind: "blocked" as const, code: "HTTP_CLIENT_ERROR" as const,
          retryAfter: "120", counters: {
            dnsCalls: 0, connectAttempts: 1, httpApplicationBytes: 0,
          } }),
        acquire: async () => { throw new Error("closed coordinator uses phased client"); },
      },
    });

    await coordinator.executeAction(41);
    expect(blocks).toEqual([[41, "HTTP_CLIENT_ERROR", false, "120", false]]);
  });

  it("uses persisted sub-fairness and returns immediately for tracked C90 work", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date("2026-08-14T12:00:00.000Z") });
    try {
      const calls: string[] = [];
      const claim = {
        id: 91,
        kind: "resource_research",
        attemptId: 901,
        attemptNo: 1,
        workerId: "composite-test",
        leaseToken: "lease-token-composite-test",
        leaseExpiresAt: "2026-08-14T12:01:00.000Z",
        task: { workflowRef: { id: "research_acquisition:c90:v1", version: 1 } },
      } as unknown as AiJobClaim;
      const ledger = {
        recoverInterrupted: (allowlist: readonly [{ id: string }]) => {
          calls.push(`recover:${allowlist[0].id}`);
          return 1;
        },
        claimNext: (_kind: string, _worker: string, _limits: unknown, _boundary: unknown,
          allowlist: readonly [{ id: string }]) => {
          calls.push(`claim:${allowlist[0].id}`);
          return allowlist[0].id === "research_acquisition:c90:v1" ? claim : undefined;
        },
      } as unknown as AiJobLedger;
      let tracked = 0;
      let c90Stopped = 0;
      let c81Stopped = 0;
      const adapter = createCompositeResourceResearchAdapter({
        connection: database.connection,
        ledger,
        c90: {
          runTrackedClaim(received) {
            expect(received).toBe(claim);
            tracked += 1;
          },
          abortAndWait: async () => { throw new Error("not used"); },
          activeCount: () => 0,
          stop: async () => { c90Stopped += 1; },
        },
        c81: {
          recoverInterrupted: () => { throw new Error("unfiltered recovery forbidden"); },
          claim: () => { throw new Error("unfiltered claim forbidden"); },
          executeClaim: async () => { throw new Error("C81 must not execute"); },
          stop: async () => { c81Stopped += 1; },
        },
        maxC90AttemptsPerUtcDay: 20,
      });

      expect(adapter.recoverInterrupted()).toBe(2);
      expect(calls.slice(0, 2)).toEqual([
        "recover:research_acquisition:c90:v1",
        "recover:research_workflow:c81:v1",
      ]);
      const execution = adapter.claim({ nextCursor: 0 });
      expect(execution?.id).toBe("resource_research:91");
      expect(execution?.execute()).toBeUndefined();
      expect(tracked).toBe(1);
      await adapter.stop?.();
      expect({ c90Stopped, c81Stopped }).toEqual({ c90Stopped: 1, c81Stopped: 1 });
    } finally {
      database.close();
    }
  });

  it("keeps C90 inert while the schema-25 composite still serves C81", async () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const calls: string[] = [];
      const c81Claim = {
        id: 81,
        kind: "resource_research",
        attemptId: 810,
        attemptNo: 1,
        workerId: "composite-off-test",
        leaseToken: "lease-token-composite-off-test",
        leaseExpiresAt: "2026-08-14T12:01:00.000Z",
        task: { workflowRef: { id: "research_workflow:c81:v1", version: 1 } },
      } as unknown as AiJobClaim;
      const ledger = {
        recoverInterrupted: (allowlist: readonly [{ id: string }]) => {
          calls.push(`recover:${allowlist[0].id}`);
          return 1;
        },
        claimNext: (_kind: string, _worker: string, _limits: unknown, _boundary: unknown,
          allowlist: readonly [{ id: string }]) => {
          calls.push(`claim:${allowlist[0].id}`);
          return allowlist[0].id === "research_workflow:c81:v1" ? c81Claim : undefined;
        },
      } as unknown as AiJobLedger;
      const c90Run = vi.fn();
      const c81Execute = vi.fn(async () => undefined);
      const adapter = createCompositeResourceResearchAdapter({
        connection: database.connection,
        ledger,
        c90Enabled: false,
        c90: { runTrackedClaim: c90Run,
          abortAndWait: async () => { throw new Error("not used"); }, activeCount: () => 0,
          stop: async () => undefined },
        c81: { recoverInterrupted: () => 0, claim: () => undefined,
          executeClaim: c81Execute, stop: async () => undefined },
      });

      expect(adapter.recoverInterrupted()).toBe(1);
      expect(calls).toEqual(["recover:research_workflow:c81:v1"]);
      const execution = adapter.claim({ nextCursor: 0 });
      expect(execution?.id).toBe("resource_research:81");
      await execution?.execute();
      expect(c81Execute).toHaveBeenCalledWith(c81Claim);
      expect(c90Run).not.toHaveBeenCalled();
      expect(calls).not.toContain("claim:research_acquisition:c90:v1");
    } finally {
      database.close();
    }
  });

  it("supersedes unknown resource-research workflows before they can head-block", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date("2026-08-14T12:00:00.000Z") });
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9901, 'host:unknown-workflow.example', '2026-08-14T12:00:00.000Z');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          9901, 'resource_research', 'resource', 9901, 'resource:9901', 'user',
          'manual', 'unknown-workflow-job', '${"a".repeat(64)}', '${"b".repeat(64)}',
          'research_unknown:v1', 1, 0, '2026-08-14T12:00:00.000Z',
          10, 1000, 1, 60000, '2026-08-14T12:00:00.000Z',
          '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, history_epoch_id, target_key,
          question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at
        ) VALUES (
          9901, 9901, 9901,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9901 AND is_active = 1),
          'resource:9901', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_unknown:v1', 1, 10, 1000, 1, 60000,
          '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (
          9901, 1, 'queued', 'queued', 'unknown-workflow-run-queued',
          '2026-08-14T12:00:00.000Z'
        );
      `);
      const ledger = {
        recoverInterrupted: () => 0,
        claimNext: () => undefined,
      } as unknown as AiJobLedger;
      const adapter = createCompositeResourceResearchAdapter({
        connection: database.connection,
        ledger,
        c90: { runTrackedClaim: () => undefined,
          abortAndWait: async () => { throw new Error("not used"); }, activeCount: () => 0,
          stop: async () => undefined },
        c81: {
          recoverInterrupted: () => 0,
          claim: () => undefined,
          executeClaim: async () => undefined,
          stop: async () => undefined,
        },
        clock: () => new Date("2026-08-14T12:00:01.000Z"),
      });

      expect(adapter.claim({ nextCursor: 0 })).toBeUndefined();
      expect(database.connection.prepare(
        "SELECT status FROM ai_jobs WHERE id = 9901",
      ).pluck().get()).toBe("superseded");
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 9901
      `).pluck().get()).toBe("superseded");
    } finally {
      database.close();
    }
  });
});
