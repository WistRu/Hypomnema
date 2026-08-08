import { afterEach, describe, expect, it, vi } from "vitest";

import { postSnapshot } from "./api";
import { PendingRequestError } from "./queue";

const emptySnapshot = { browser: "chrome", tabs: [] };

afterEach(() => {
  vi.unstubAllGlobals();
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
