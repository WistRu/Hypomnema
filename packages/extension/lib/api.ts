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
      const detail = (await response.text()).slice(0, 200).trim();
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      throw new Error(`Snapshot upload failed (HTTP ${response.status})${suffix}`);
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
      const detail = (await response.text()).slice(0, 200).trim();
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      throw new Error(`Content upload failed (HTTP ${response.status})${suffix}`);
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
