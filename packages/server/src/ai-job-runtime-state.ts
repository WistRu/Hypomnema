import type Database from "better-sqlite3";

import { DurableAiJobError } from "./durable-ai-jobs.js";

export type AiJobRuntimeCursor = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AiJobClaimBoundary {
  readonly nextCursor: AiJobRuntimeCursor;
}

export interface AiJobRuntimeCursorStore {
  read(): AiJobRuntimeCursor;
}

interface RuntimeStateRow {
  readonly cursor: unknown;
}

export function normalizeAiJobRuntimeCursor(value: unknown): AiJobRuntimeCursor {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 6) {
    throw new DurableAiJobError(
      "JOB_STORAGE_CORRUPT",
      "Stored AI job runtime cursor is invalid",
    );
  }
  return value as AiJobRuntimeCursor;
}

export function normalizeAiJobClaimBoundary(
  value: AiJobClaimBoundary | undefined,
): AiJobClaimBoundary | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join(",") !== "nextCursor") {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job claim boundary");
  }
  return { nextCursor: normalizeBoundaryCursor(value.nextCursor) };
}

function normalizeBoundaryCursor(value: unknown): AiJobRuntimeCursor {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 6) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job claim boundary");
  }
  return value as AiJobRuntimeCursor;
}

export function prepareAiJobRuntimeClaimBoundary(connection: Database.Database): {
  advance(boundary: AiJobClaimBoundary | undefined, occurredAt: string): void;
} {
  const runtimeStateAvailable = connection.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'ai_job_runtime_state'
  `).pluck().get() === 1;
  if (!runtimeStateAvailable) {
    return {
      advance(boundary) {
        if (normalizeAiJobClaimBoundary(boundary) !== undefined) {
          throw new DurableAiJobError(
            "JOB_STORAGE_CORRUPT",
            "AI job runtime cursor authority is unavailable",
          );
        }
      },
    };
  }
  const select = connection.prepare(`
    SELECT updated_at FROM ai_job_runtime_state WHERE singleton_id = 1
  `);
  const update = connection.prepare(`
    UPDATE ai_job_runtime_state
    SET cursor = @cursor, updated_at = @occurredAt
    WHERE singleton_id = 1
  `);
  return {
    advance(boundary, occurredAt) {
      const normalized = normalizeAiJobClaimBoundary(boundary);
      if (normalized === undefined) return;
      const current = select.get() as { updated_at: unknown } | undefined;
      if (current === undefined) {
        throw new DurableAiJobError(
          "JOB_STORAGE_CORRUPT",
          "AI job runtime cursor authority is unavailable",
        );
      }
      if (typeof current.updated_at !== "string") {
        throw new DurableAiJobError(
          "JOB_STORAGE_CORRUPT",
          "Stored AI job runtime cursor is invalid",
        );
      }
      if (occurredAt < current.updated_at) {
        throw new DurableAiJobError(
          "JOB_CLOCK_REGRESSION",
          "AI job runtime clock regressed",
        );
      }
      if (update.run({ cursor: normalized.nextCursor, occurredAt }).changes !== 1) {
        throw new DurableAiJobError(
          "JOB_STORAGE_CORRUPT",
          "AI job runtime cursor authority is unavailable",
        );
      }
    },
  };
}

export function createAiJobRuntimeCursorStore(
  connection: Database.Database,
): AiJobRuntimeCursorStore {
  const select = connection.prepare(`
    SELECT cursor FROM ai_job_runtime_state WHERE singleton_id = 1
  `);
  return {
    read() {
      const row = select.get() as RuntimeStateRow | undefined;
      if (row === undefined) {
        throw new DurableAiJobError(
          "JOB_STORAGE_CORRUPT",
          "AI job runtime cursor authority is unavailable",
        );
      }
      return normalizeAiJobRuntimeCursor(row.cursor);
    },
  };
}
