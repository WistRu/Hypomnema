import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ingestSnapshotBodyLimitBytes,
  type IngestSnapshot,
} from "@tabhub/shared";

import { postSnapshot, snapshotRequestTimeoutMs } from "./api";
import { REQUEST_TIMEOUT_MS } from "./constants";
import { PendingRequestError } from "./queue";

const emptySnapshot = { browser: "chrome", tabs: [] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("snapshot upload timeout", () => {
  it("scales through the complete 15 MiB transport budget", () => {
    expect(snapshotRequestTimeoutMs(0)).toBe(10_000);
    expect(snapshotRequestTimeoutMs(1024 * 1024)).toBe(18_000);
    expect(snapshotRequestTimeoutMs(ingestSnapshotBodyLimitBytes)).toBe(
      130_000,
    );
  });

  it("does not abort a large valid snapshot at the former five-second deadline", async () => {
    vi.useFakeTimers();
    const largeSnapshot: IngestSnapshot = {
      browser: "chrome",
      tabs: Array.from({ length: 600 }, (_, index) => ({
        index,
        title: "x".repeat(2_048),
        url: `https://example.com/${index}`,
        windowId: 7,
      })),
    };
    let completeFetch: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((resolve) => {
          completeFetch = resolve;
        });
      }),
    );

    const upload = postSnapshot(largeSnapshot);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    expect(requestSignal?.aborted).toBe(false);
    expect(completeFetch).toBeTypeOf("function");
    completeFetch!(new Response(null, { status: 204 }));
    await upload;
  });
});

describe("HTTP upload failure classification", () => {
  it("marks ordinary client errors as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid body", { status: 400 })),
    );

    const error = await postSnapshot(emptySnapshot).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PendingRequestError);
    expect(error).toMatchObject({ retryable: false, statusCode: 400 });
  });

  it.each([408, 425, 429, 500, 503])(
    "marks HTTP %i as transient",
    async (statusCode) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("retry later", { status: statusCode })),
      );

      const error = await postSnapshot(emptySnapshot).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PendingRequestError);
      expect(error).toMatchObject({ retryable: true, statusCode });
    },
  );
});
