import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExactInstanceCaptureReceipt,
  TabCommandRelayCaptureTarget,
  TabCommandScope,
} from "@tabhub/shared";

import {
  createExactInstanceCaptureExecutor,
  TabCommandExecutionExpiredError,
  type ExactInstanceCaptureExecutorOptions,
} from "./exact-instance-capture";

const ENDPOINT = "http://127.0.0.1:7717/api/ingest/exact-instance-content";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnop";
const SCOPE: TabCommandScope = {
  browser: "chrome",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const TARGET: TabCommandRelayCaptureTarget = {
  instanceId: 73,
  tabId: 42,
  expectedUrl: "https://example.com/exact",
  expectedInstanceRevision: 4,
  expectedFirstSeenAt: "2026-08-13T11:00:00.000Z",
};
const RECEIPT: ExactInstanceCaptureReceipt = {
  instanceId: TARGET.instanceId,
  browserTabId: TARGET.tabId,
  canonicalTabId: 123,
  logicalPageId: 456,
  capturedUrl: TARGET.expectedUrl,
  instanceRevision: TARGET.expectedInstanceRevision,
  firstSeenAt: TARGET.expectedFirstSeenAt,
  contentRevision: 8,
  extractedAt: "2026-08-13T11:01:00.000Z",
};
const EXECUTION = {
  executionDeadlineAt: 10_000,
  requestId: "523e4567-e89b-42d3-a456-426614174000",
  requestedScope: SCOPE,
  target: TARGET,
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function extracted(overrides: Record<string, unknown> = {}) {
  return {
    htmlExcerpt: "<main>Exact content</main>",
    text: "Exact content",
    url: TARGET.expectedUrl,
    ...overrides,
  };
}

function harness(
  overrides: Partial<ExactInstanceCaptureExecutorOptions> = {},
) {
  const getTab = vi.fn(async () => ({
    id: TARGET.tabId,
    url: TARGET.expectedUrl,
  }));
  const extract = vi.fn(async () => extracted());
  const fetcher = vi.fn(async (_input: string, _init: RequestInit) =>
    jsonResponse(RECEIPT));
  const options: ExactInstanceCaptureExecutorOptions = {
    endpoint: ENDPOINT,
    extensionOrigin: () => EXTENSION_ORIGIN,
    extract,
    fetch: fetcher,
    getCurrentScope: vi.fn(async () => SCOPE),
    getTab,
    now: () => 1_000,
    ...overrides,
  };
  return {
    execute: createExactInstanceCaptureExecutor(options),
    extract,
    fetcher,
    getTab,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("exact-instance capture executor", () => {
  it("captures only the selected physical copy and echoes the exact durable receipt", async () => {
    const { execute, extract, fetcher, getTab } = harness();

    await expect(execute(EXECUTION)).resolves.toEqual({
      kind: "capture-tab-content",
      target: TARGET,
      outcome: { status: "captured", receipt: RECEIPT },
    });

    expect(getTab).toHaveBeenCalledTimes(2);
    expect(getTab).toHaveBeenNthCalledWith(1, 42);
    expect(getTab).toHaveBeenNthCalledWith(2, 42);
    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(42);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tabhub-extension-origin": EXTENSION_ORIGIN,
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      ...SCOPE,
      commandRequestId: EXECUTION.requestId,
      target: TARGET,
      observedUrl: TARGET.expectedUrl,
      text: "Exact content",
      htmlExcerpt: "<main>Exact content</main>",
    });
  });

  it("fails without touching a tab when the relay scope is stale", async () => {
    const { execute, fetcher, getTab } = harness({
      getCurrentScope: vi.fn(async () => ({
        ...SCOPE,
        browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
      })),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_SCOPE_MISMATCH", recoverable: true },
      },
    });
    expect(getTab).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes a closed exact tab before extraction", async () => {
    const { execute, extract, fetcher } = harness({
      getTab: vi.fn(async () => {
        throw new Error("No tab with id: 42");
      }),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_TAB_CLOSED" },
      },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/other", "CAPTURE_TAB_NAVIGATED"],
    ["chrome://settings/", "CAPTURE_PAGE_UNSUPPORTED"],
  ])("rejects pre-extraction URL %s as %s", async (url, code) => {
    const target = url.startsWith("chrome:")
      ? { ...TARGET, expectedUrl: url }
      : TARGET;
    const { execute, extract, fetcher } = harness({
      getTab: vi.fn(async () => ({ id: TARGET.tabId, url })),
    });

    await expect(execute({ ...EXECUTION, target })).resolves.toMatchObject({
      outcome: { status: "failed", failure: { code } },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: undefined, url: TARGET.expectedUrl }, "CAPTURE_TAB_CLOSED"],
    [
      { id: TARGET.tabId, url: TARGET.expectedUrl, discarded: true },
      "CAPTURE_PAGE_UNSUPPORTED",
    ],
    [
      {
        id: TARGET.tabId,
        url: TARGET.expectedUrl,
        pendingUrl: "https://example.com/pending",
      },
      "CAPTURE_TAB_NAVIGATED",
    ],
    [
      { id: TARGET.tabId, url: TARGET.expectedUrl, status: "loading" as const },
      "CAPTURE_TAB_NAVIGATED",
    ],
  ])("fails closed on unstable tab state %#", async (tab, code) => {
    const { execute, extract, fetcher } = harness({
      getTab: vi.fn(async () => tab),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: { status: "failed", failure: { code } },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [null, "malformed extractor result"],
    [extracted({ text: "  \n " }), "blank extracted text"],
  ])("rejects %s without ingest", async (value, _description) => {
    const { execute, fetcher } = harness({
      extract: vi.fn(async () => value),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_EXTRACTION_FAILED" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps an injection failure to extraction failed without ingest", async () => {
    const { execute, fetcher } = harness({
      extract: vi.fn(async () => {
        throw new Error("Cannot access contents of the page");
      }),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_EXTRACTION_FAILED" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats an extractor URL change as navigation without ingest", async () => {
    const { execute, fetcher } = harness({
      extract: vi.fn(async () =>
        extracted({ url: "https://example.com/extracted-other" })),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_TAB_NAVIGATED" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not ingest when the tab closes during extraction", async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ id: TARGET.tabId, url: TARGET.expectedUrl })
      .mockRejectedValueOnce(new Error("closed"));
    const { execute, fetcher } = harness({ getTab });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_TAB_CLOSED" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not ingest when the tab navigates during extraction", async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ id: TARGET.tabId, url: TARGET.expectedUrl })
      .mockResolvedValueOnce({
        id: TARGET.tabId,
        url: "https://example.com/after",
      });
    const { execute, fetcher } = harness({ getTab });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_TAB_NAVIGATED" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["discarded", { id: TARGET.tabId, url: TARGET.expectedUrl, discarded: true }],
    [
      "pending navigation",
      {
        id: TARGET.tabId,
        url: TARGET.expectedUrl,
        pendingUrl: "https://example.com/pending-after",
      },
    ],
    [
      "loading",
      { id: TARGET.tabId, url: TARGET.expectedUrl, status: "loading" as const },
    ],
  ])("does not ingest when the tab becomes %s after extraction", async (_state, tabAfter) => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ id: TARGET.tabId, url: TARGET.expectedUrl })
      .mockResolvedValueOnce(tabAfter);
    const { execute, fetcher } = harness({ getTab });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: { status: "failed" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates the exact browser scope immediately before ingest", async () => {
    const getCurrentScope = vi
      .fn()
      .mockResolvedValueOnce(SCOPE)
      .mockResolvedValueOnce({
        ...SCOPE,
        browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
      });
    const { execute, fetcher } = harness({ getCurrentScope });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_SCOPE_MISMATCH" },
      },
    });
    expect(getCurrentScope).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a typed recoverable server rejection", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: "CAPTURE_INSTANCE_STALE",
          message: "The selected instance revision is stale.",
          recoverable: true,
        },
        409,
      ),
    );
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: {
          code: "CAPTURE_INSTANCE_STALE",
          message: "The selected instance revision is stale.",
        },
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a malformed 400 response without retrying or calling it offline", async () => {
    const response = new Response("not-json", { status: 400 });
    const fetcher = vi.fn(async () => response);
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_INGEST_REJECTED" },
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries one ambiguous response loss with an identical request", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network response lost"))
      .mockResolvedValueOnce(jsonResponse(RECEIPT));
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: { status: "captured", receipt: RECEIPT },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(fetcher.mock.calls[0]?.[0]);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      fetcher.mock.calls[0]?.[1]?.body,
    );
  });

  it("retries one response-body loss after 200 with an identical request", async () => {
    const lostResponse = jsonResponse(RECEIPT);
    vi.spyOn(lostResponse, "json").mockRejectedValueOnce(
      new TypeError("response body lost"),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(lostResponse)
      .mockResolvedValueOnce(jsonResponse(RECEIPT));
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: { status: "captured", receipt: RECEIPT },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      fetcher.mock.calls[0]?.[1]?.body,
    );
  });

  it("retries one untyped 500 response with an identical request", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "INTERNAL" }, 500))
      .mockResolvedValueOnce(jsonResponse(RECEIPT));
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: { status: "captured", receipt: RECEIPT },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      fetcher.mock.calls[0]?.[1]?.body,
    );
  });

  it("returns unavailable after exactly two failed network attempts", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const { execute } = harness({ fetch: fetcher });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_INGEST_UNAVAILABLE" },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["instanceId", RECEIPT.instanceId + 1],
    ["browserTabId", RECEIPT.browserTabId + 1],
    ["capturedUrl", "https://example.com/other"],
    ["instanceRevision", RECEIPT.instanceRevision + 1],
    ["firstSeenAt", "2026-08-13T11:00:01.000Z"],
  ])("rejects a receipt whose %s belongs to another instance", async (field, value) => {
    const { execute } = harness({
      fetch: vi.fn(async () => jsonResponse({ ...RECEIPT, [field]: value })),
    });

    await expect(execute(EXECUTION)).resolves.toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "CAPTURE_INGEST_REJECTED" },
      },
    });
  });

  it("aborts after extraction when the command deadline expires", async () => {
    let currentTime = 1_000;
    const { execute, fetcher, getTab } = harness({
      extract: vi.fn(async () => {
        currentTime = EXECUTION.executionDeadlineAt;
        return extracted();
      }),
      now: () => currentTime,
    });

    await expect(execute(EXECUTION)).rejects.toBeInstanceOf(
      TabCommandExecutionExpiredError,
    );
    expect(getTab).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept a receipt whose response body completes after deadline", async () => {
    let currentTime = 1_000;
    const response = jsonResponse(RECEIPT);
    vi.spyOn(response, "json").mockImplementation(async () => {
      currentTime = EXECUTION.executionDeadlineAt;
      return RECEIPT;
    });
    const fetcher = vi.fn(async () => response);
    const { execute } = harness({ fetch: fetcher, now: () => currentTime });

    await expect(execute(EXECUTION)).rejects.toBeInstanceOf(
      TabCommandExecutionExpiredError,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps the deadline abort signal active while reading the response body", async () => {
    vi.useFakeTimers();
    let currentTime = 1_000;
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_input: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise<never>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => {
              currentTime = 6_000;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      } as unknown as Response;
    });
    const { execute } = harness({ fetch: fetcher, now: () => currentTime });
    const result = execute({ ...EXECUTION, executionDeadlineAt: 6_000 });
    const rejection = expect(result).rejects.toBeInstanceOf(
      TabCommandExecutionExpiredError,
    );
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
