import {
  healthResponseSchema,
  type IngestContent,
  type IngestSnapshot,
} from "@tabhub/shared";

import {
  CONTENT_ENDPOINT,
  HEALTH_ENDPOINT,
  REQUEST_TIMEOUT_MS,
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
  operation: "Content" | "Snapshot",
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
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function postSnapshot(snapshot: IngestSnapshot): Promise<void> {
  await withRequestTimeout(async (signal) => {
    const response = await fetch(SNAPSHOT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
      signal,
    });

    if (!response.ok) {
      throw await responseError("Snapshot", response);
    }
  });
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
