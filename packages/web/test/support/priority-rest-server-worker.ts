import process from "node:process";

import type { PrioritySafeRead, TabListResponse } from "@tabhub/shared";

import { createApp } from "../../../server/src/app.js";

const now = new Date("2026-08-13T10:00:00.000Z");
const flagsOn = {
  activityDailyWriter: false,
  activityWindows: false,
  context: false,
  logicalImportance: true,
  resources: true,
  priorityAssessmentWriter: true,
  priorityReaders: true,
  priorityShadow: true,
  research: false,
} as const;
const flagsOff = {
  ...flagsOn,
  logicalImportance: false,
  resources: false,
  priorityAssessmentWriter: false,
  priorityReaders: false,
  priorityShadow: false,
} as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function waitForPriorityJob(
  app: ReturnType<typeof createApp>,
  jobId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/ai/jobs/${jobId}`,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Priority job read failed with ${response.statusCode}`);
    }
    const status = (response.json() as { status: string }).status;
    if (status !== "queued" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "timed_out";
}

async function start() {
  const mode = requiredEnvironment("TABHUB_TEST_PRIORITY_PROFILE");
  const databasePath = requiredEnvironment("TABHUB_TEST_DATABASE_PATH");
  const app = createApp({
    databasePath,
    featureFlags: mode === "on" ? flagsOn : flagsOff,
    logger: false,
    clock: () => now,
    migrationClock: () => now,
    maximumMigrationVersion: 24,
  });

  const health = await app.inject({ method: "GET", url: "/api/health" });
  if (health.statusCode !== 200 || health.json().schemaVersion !== 24) {
    throw new Error(`Expected disposable schema 24, got ${health.body}`);
  }

  let setup: Record<string, unknown> = { schemaVersion: 24 };
  if (mode === "on") {
    const ingest = await app.inject({
      method: "POST",
      url: "/api/ingest/snapshot",
      payload: {
        browser: "chrome",
        installationId: "313e4567-e89b-42d3-a456-426614174000",
        browserSessionId: "413e4567-e89b-42d3-a456-426614174000",
        tabs: [
          {
            tabId: 27,
            url: "https://priority-rest.example/research",
            title: "Priority REST research",
            windowId: 1,
            index: 0,
            pinned: true,
          },
          {
            tabId: 28,
            url: "https://priority-rest.example/reference",
            title: "Priority REST reference",
            windowId: 1,
            index: 1,
            pinned: false,
          },
        ],
      },
    });
    if (ingest.statusCode !== 200) {
      throw new Error(`Fixture ingest failed with ${ingest.statusCode}: ${ingest.body}`);
    }

    const initialList = await app.inject({
      method: "GET",
      url: "/api/tabs?page=1&pageSize=50",
    });
    if (initialList.statusCode !== 200) {
      throw new Error(`Fixture list failed with ${initialList.statusCode}`);
    }
    const listed = initialList.json() as TabListResponse;
    const initialDefaultOrder = listed.items.map(({ title }) => title);
    const research = listed.items.find(
      ({ url }) => url === "https://priority-rest.example/research",
    );
    if (research === undefined || research.logicalPageId === undefined) {
      throw new Error("Expected ingested research page with a logical ID");
    }

    const manualImportance = await app.inject({
      method: "PATCH",
      url: "/api/tabs/importance",
      payload: { ids: [research.id], importance: 3 },
    });
    if (manualImportance.statusCode !== 200) {
      throw new Error(
        `Manual importance failed with ${manualImportance.statusCode}: ${manualImportance.body}`,
      );
    }

    const recompute = await app.inject({
      method: "POST",
      url: "/api/agent/personalization/priority/recompute",
      payload: {
        idempotencyKey: "web-rest-priority-collection",
        authorizationRef: "user-instruction:web-rest-priority-collection",
        stepBatchSize: 10,
      },
    });
    if (recompute.statusCode !== 200) {
      throw new Error(`Priority recompute failed with ${recompute.statusCode}: ${recompute.body}`);
    }
    const jobStatus = await waitForPriorityJob(
      app,
      (recompute.json() as { id: string }).id,
    );
    if (jobStatus !== "succeeded") {
      throw new Error(`Priority recompute ended as ${jobStatus}`);
    }

    const priorityResponse = await app.inject({
      method: "GET",
      url: `/api/logical-pages/${research.logicalPageId}/priority`,
    });
    if (priorityResponse.statusCode !== 200) {
      throw new Error(`Priority read failed with ${priorityResponse.statusCode}`);
    }
    const finalList = await app.inject({
      method: "GET",
      url: "/api/tabs?page=1&pageSize=50",
    });
    if (finalList.statusCode !== 200) {
      throw new Error(`Post-run list failed with ${finalList.statusCode}`);
    }
    const postRunDefaultOrder = (finalList.json() as TabListResponse).items.map(
      ({ title }) => title,
    );
    if (JSON.stringify(postRunDefaultOrder) !== JSON.stringify(initialDefaultOrder)) {
      throw new Error(
        `Priority setup changed the default tab order: ${JSON.stringify({
          initialDefaultOrder,
          postRunDefaultOrder,
        })}`,
      );
    }
    setup = {
      ...setup,
      initialDefaultOrder,
      postRunDefaultOrder,
      priority: priorityResponse.json() as PrioritySafeRead,
      research: {
        id: research.id,
        logicalPageId: research.logicalPageId,
      },
    };
  }

  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  process.send?.({ type: "ready", origin, ...setup });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.send?.({ type: "stopped" });
    process.exit(0);
  };
  process.on("message", (message) => {
    if (message === "stop") void close();
  });
  process.once("SIGTERM", () => void close());
}

void start().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  process.send?.({
    type: "error",
    message: normalized.message,
    stack: normalized.stack,
  });
  process.exit(1);
});
