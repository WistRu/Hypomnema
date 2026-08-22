import Fastify from "fastify";
import type { PrivacyPurgeStatusResponse } from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivacyPurgeCoordinatorError } from "../src/privacy-purge-coordinator.js";
import { registerPrivacyPurgeRoutes } from "../src/privacy-purge-routes.js";
import type { LocalCapabilityService } from "../src/local-capability.js";

const KEY = "a".repeat(64);
const purgeId = `purge_${KEY}`;
const waiting: PrivacyPurgeStatusResponse = { version: 1 as const, purgeId,
  target: { kind: "logical_page" as const, logicalPageId: 1 }, state: "waiting" as const,
  progress: { completedSteps: 0, totalSteps: 2 }, holdReason: null,
  canRetry: false, timestamps: { createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z", completedAt: null }, result: null };

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(enabled = true) {
  const app = Fastify(); apps.push(app);
  const coordinator = { start: vi.fn(async (): Promise<PrivacyPurgeStatusResponse> => waiting),
    read: vi.fn((): PrivacyPurgeStatusResponse | null => waiting),
    retry: vi.fn(async (): Promise<PrivacyPurgeStatusResponse> => waiting), driveOnce: vi.fn() };
  const wake = vi.fn();
  const capabilities = { authenticate: vi.fn((request) => request.headers.authorization === "Bearer test"
    ? { kind: "web", installationId: null } : null) } as unknown as LocalCapabilityService;
  registerPrivacyPurgeRoutes(app, { capabilities, coordinator, runtime: { wake },
    newStartsEnabled: enabled });
  if (!enabled) coordinator.start.mockRejectedValue(
    new PrivacyPurgeCoordinatorError("PURGE_NEW_START_DISABLED"));
  return { app, coordinator, wake, headers: { authorization: "Bearer test" } };
}

describe("privacy purge routes", () => {
  it("requires local auth and validates without leaking issues", async () => {
    const value = fixture();
    expect((await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      payload: {} })).statusCode).toBe(401);
    const invalid = await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: { version: 1, idempotencyKey: "x",
        target: { kind: "logical_page", logicalPageId: 1 }, url: "secret" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "PURGE_INVALID_REQUEST" });
  });

  it("starts, replays, wakes, and returns 202 or terminal 200", async () => {
    const value = fixture();
    const input = { version: 1, idempotencyKey: "x",
      target: { kind: "logical_page", logicalPageId: 1 } };
    const first = await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: input });
    expect(first.statusCode).toBe(202); expect(value.wake).toHaveBeenCalledWith(purgeId);
    value.coordinator.start.mockResolvedValue({ ...waiting, state: "completed",
      progress: { completedSteps: 2, totalSteps: 2 },
      timestamps: { ...waiting.timestamps, completedAt: waiting.timestamps.createdAt },
      result: { deletedRows: 0 } });
    expect((await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: input })).statusCode).toBe(200);
  });

  it("keeps authenticated GET and retry available while new starts are off", async () => {
    const value = fixture(false);
    const disabled = await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: { version: 1, idempotencyKey: "x",
        target: { kind: "logical_page", logicalPageId: 1 } } });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({ error: "FEATURE_DISABLED",
      feature: "privacyPurge" });
    expect(value.coordinator.start).toHaveBeenLastCalledWith(expect.anything(),
      { allowCreate: false });
    value.coordinator.start.mockResolvedValueOnce(waiting);
    const replay = await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: { version: 1, idempotencyKey: "lost-response",
        target: waiting.target } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().purgeId).toBe(purgeId);
    value.coordinator.start.mockRejectedValueOnce(new PrivacyPurgeCoordinatorError(
      "PURGE_IDEMPOTENCY_CONFLICT"));
    expect((await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: { version: 1, idempotencyKey: "lost-response",
        target: { kind: "run", researchRunId: 2 } } })).statusCode).toBe(409);
    expect((await value.app.inject({ method: "GET", url: `/api/privacy/purges/${purgeId}`,
      headers: value.headers })).statusCode).toBe(200);
    expect((await value.app.inject({ method: "POST",
      url: `/api/privacy/purges/${purgeId}/retry`, headers: value.headers })).statusCode).toBe(202);
    expect(value.wake).toHaveBeenCalledWith(purgeId);
  });

  it("returns 200 for both terminal completed and failed start/retry responses", async () => {
    const value = fixture();
    const failed: PrivacyPurgeStatusResponse = { ...waiting, state: "failed",
      progress: { completedSteps: 2, totalSteps: 2 },
      timestamps: { ...waiting.timestamps, completedAt: waiting.timestamps.createdAt },
      result: { deletedRows: 0 } };
    value.coordinator.start.mockResolvedValue(failed);
    value.coordinator.retry.mockResolvedValue(failed);
    expect((await value.app.inject({ method: "POST", url: "/api/privacy/purges",
      headers: value.headers, payload: { version: 1, idempotencyKey: "failed",
        target: waiting.target } })).statusCode).toBe(200);
    expect((await value.app.inject({ method: "POST",
      url: `/api/privacy/purges/${purgeId}/retry`, headers: value.headers })).statusCode)
      .toBe(200);
  });

  it("maps only safe typed errors and returns strict 404s", async () => {
    const value = fixture(); value.coordinator.read.mockReturnValue(null);
    expect((await value.app.inject({ method: "GET", url: `/api/privacy/purges/${purgeId}`,
      headers: value.headers })).json()).toEqual({ error: "PURGE_NOT_FOUND" });
    value.coordinator.retry.mockRejectedValue(new PrivacyPurgeCoordinatorError(
      "PURGE_RETRY_NOT_ALLOWED"));
    const conflict = await value.app.inject({ method: "POST",
      url: `/api/privacy/purges/${purgeId}/retry`, headers: value.headers });
    expect(conflict.statusCode).toBe(409);
    value.coordinator.retry.mockRejectedValue(new Error("secret digest url"));
    expect((await value.app.inject({ method: "POST",
      url: `/api/privacy/purges/${purgeId}/retry`, headers: value.headers })).json())
      .toEqual({ error: "PURGE_UNAVAILABLE" });
  });
});
