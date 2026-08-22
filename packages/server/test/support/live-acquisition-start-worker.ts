import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

import type { LiveAcquisitionStartRequest } from "@tabhub/shared";

import { openDatabase } from "../../src/database.ts";
import { createLiveAcquisitionWorkflow } from "../../src/live-acquisition-workflow.ts";
import { createResearchStore } from "../../src/research-store.ts";

interface StartWorkerData {
  readonly databasePath: string;
  readonly request: LiveAcquisitionStartRequest;
  readonly mode: "lock_owner" | "contender";
  readonly barrier: SharedArrayBuffer;
  readonly at: string;
}

const input = workerData as StartWorkerData;
const barrier = new Int32Array(input.barrier);
const database = openDatabase(input.databasePath, {
  migrationClock: () => new Date(input.at),
});
let quoteCalls = 0;
const workflow = createLiveAcquisitionWorkflow({
  connection: database.connection,
  research: createResearchStore(database.connection, {
    clock: () => new Date(input.at),
  }),
  provider: {
    metadata: {
      provider: "anthropic",
      model: "test",
      promptVersion: "p1",
      pricingVersion: "price1",
    },
    quote: () => {
      quoteCalls += 1;
      return {
        version: "research_provider_quote:v1",
        inputDigest: createHash("sha256").update("provider-input").digest("hex"),
        calls: 1,
        inputTokens: 2_000,
        outputTokens: 8_192,
        costUsd: 0.25,
        wallTimeMs: 120_000,
      };
    },
  },
  clock: () => new Date(input.at),
  digestKey: () => Buffer.alloc(32, 7),
  ...(input.mode === "lock_owner"
    ? {
        fault(point: string) {
          if (point !== "after_job_insert") return;
          Atomics.store(barrier, 0, 1);
          Atomics.notify(barrier, 0);
          Atomics.wait(barrier, 1, 0, 60_000);
        },
      }
    : {}),
});

try {
  if (input.mode === "contender") {
    Atomics.store(barrier, 2, 1);
    Atomics.notify(barrier, 2);
    Atomics.wait(barrier, 3, 0, 60_000);
    Atomics.store(barrier, 4, 1);
    Atomics.notify(barrier, 4);
  }
  const receipt = workflow.start(input.request);
  parentPort?.postMessage({ kind: "result", receipt, quoteCalls });
} catch (error) {
  parentPort?.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  database.close();
}
