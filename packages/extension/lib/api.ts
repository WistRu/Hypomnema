import {
  healthResponseSchema,
  ingestSnapshotBodyLimitBytes,
  type IngestActivity,
  type IngestContent,
  type IngestSnapshot,
} from "@tabhub/shared";

import {
  ACTIVITY_ENDPOINT,
  CONTENT_ENDPOINT,
  HEALTH_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  SNAPSHOT_REQUEST_BASE_TIMEOUT_MS,
  SNAPSHOT_REQUEST_MIN_THROUGHPUT_BYTES_PER_SECOND,
  SNAPSHOT_ENDPOINT,
} from "./constants";
import { PendingRequestError } from "./queue";

const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

function isRetryableStatus(status: number): boolean {
  return (
    status < 400 ||
    status >= 500 ||
    TRANSIENT_CLIENT_STATUSES.has(status)
  );
}

async function responseError(
  operation: "Activity" | "Content" | "Snapshot",
  response: Response,
): Promise<PendingRequestError> {
  const detail = (await response.text()).slice(0, 200).trim();
  const suffix = detail.length > 0 ? `: ${detail}` : "";

  return new PendingRequestError(
    `${operation} upload failed (HTTP ${response.status})${suffix}`,
    {
      retryable: isRetryableStatus(response.status),
      statusCode: response.status,
    },
  );
}

async function withRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function snapshotRequestTimeoutMs(byteLength: number): number {
  // IngestSnapshot has already passed the shared 15 MiB transport contract.
  // Clamp only the timeout calculation defensively; this does not truncate or
  // reject the payload. At the budget boundary the request gets 130 seconds:
  // 10 seconds of processing headroom plus 15 MiB at 128 KiB/s.
  const transportBytes = Math.min(
    ingestSnapshotBodyLimitBytes,
    Math.max(0, Math.ceil(byteLength)),
  );
  const transferSeconds = Math.ceil(
    transportBytes / SNAPSHOT_REQUEST_MIN_THROUGHPUT_BYTES_PER_SECOND,
  );
  return SNAPSHOT_REQUEST_BASE_TIMEOUT_MS + transferSeconds * 1_000;
}

export async function postSnapshot(snapshot: IngestSnapshot): Promise<void> {
  const body = JSON.stringify(snapshot);
  const timeoutMs = snapshotRequestTimeoutMs(
    new TextEncoder().encode(body).byteLength,
  );
  await withRequestTimeout(async (signal) => {
    const response = await fetch(SNAPSHOT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });

    if (!response.ok) {
      throw await responseError("Snapshot", response);
    }
  }, timeoutMs);
}

export async function postContent(content: IngestContent): Promise<void> {
  await withRequestTimeout(async (signal) => {
    const response = await fetch(CONTENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(content),
      signal,
    });

    if (!response.ok) {
      throw await responseError("Content", response);
    }
  });
}

export async function postActivity(activity: IngestActivity): Promise<void> {
  await withRequestTimeout(async (signal) => {
    const response = await fetch(ACTIVITY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(activity),
      signal,
    });

    if (!response.ok) {
      throw await responseError("Activity", response);
    }
  });
}

export async function isServerReachable(): Promise<boolean> {
  try {
    return await withRequestTimeout(async (signal) => {
      const response = await fetch(HEALTH_ENDPOINT, {
        cache: "no-store",
        signal,
      });

      if (!response.ok) {
        return false;
      }

      return healthResponseSchema.safeParse(await response.json()).success;
    });
  } catch {
    return false;
  }
}
