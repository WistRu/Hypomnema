import {
  exactInstanceCaptureFailureSchema,
  exactInstanceContentIngestErrorSchema,
  exactInstanceContentIngestResponseSchema,
  exactInstanceContentIngestSchema,
  tabCommandRelayResultSchema,
  tabUrlSchema,
  type ExactInstanceCaptureFailure,
  type ExactInstanceContentIngest,
  type TabCommandRelayCaptureTarget,
  type TabCommandRelayResult,
  type TabCommandScope,
} from "@tabhub/shared";

import { parseExtractedPage, type TabExtractor } from "./content-capture";
import { REQUEST_TIMEOUT_MS } from "./constants";

export interface ExactInstanceCaptureTab {
  discarded?: boolean | undefined;
  id?: number | undefined;
  pendingUrl?: string | undefined;
  status?: "complete" | "loading" | "unloaded" | undefined;
  url?: string | undefined;
}

export interface ExactInstanceCaptureExecution {
  executionDeadlineAt: number;
  requestId: string;
  requestedScope: TabCommandScope;
  target: TabCommandRelayCaptureTarget;
}

export interface ExactInstanceCaptureExecutorOptions {
  endpoint: string;
  extensionOrigin(): string;
  extract: TabExtractor;
  fetch(input: string, init: RequestInit): Promise<Response>;
  getCurrentScope(): Promise<TabCommandScope | undefined>;
  getTab(tabId: number): Promise<ExactInstanceCaptureTab>;
  now?: () => number;
}

export class TabCommandExecutionExpiredError extends Error {
  constructor() {
    super("The browser command expired during execution.");
    this.name = "TabCommandExecutionExpiredError";
  }
}

function scopesEqual(left: TabCommandScope, right: TabCommandScope): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function isSupportedPageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function observedUrl(url: unknown): string | undefined {
  const parsed = tabUrlSchema.safeParse(url);
  return parsed.success ? parsed.data : undefined;
}

function failure(
  code: ExactInstanceCaptureFailure["code"],
  message: string,
  url?: unknown,
): ExactInstanceCaptureFailure {
  const validObservedUrl = observedUrl(url);
  return exactInstanceCaptureFailureSchema.parse({
    code,
    message,
    recoverable: true,
    ...(validObservedUrl === undefined
      ? {}
      : { observedUrl: validObservedUrl }),
  });
}

function failedResult(
  target: TabCommandRelayCaptureTarget,
  exactFailure: ExactInstanceCaptureFailure,
): TabCommandRelayResult {
  return tabCommandRelayResultSchema.parse({
    kind: "capture-tab-content",
    target,
    outcome: {
      status: "failed",
      failure: exactFailure,
    },
  });
}

function assertBeforeDeadline(now: () => number, deadline: number): void {
  if (now() >= deadline) {
    throw new TabCommandExecutionExpiredError();
  }
}

async function readTab(
  options: ExactInstanceCaptureExecutorOptions,
  target: TabCommandRelayCaptureTarget,
): Promise<ExactInstanceCaptureTab | ExactInstanceCaptureFailure> {
  try {
    return await options.getTab(target.tabId);
  } catch {
    return failure(
      "CAPTURE_TAB_CLOSED",
      "The selected browser tab is no longer open.",
    );
  }
}

function validateTab(
  tab: ExactInstanceCaptureTab,
  target: TabCommandRelayCaptureTarget,
): ExactInstanceCaptureFailure | undefined {
  if (tab.id !== target.tabId) {
    return failure(
      "CAPTURE_TAB_CLOSED",
      "The selected browser tab is no longer available.",
    );
  }
  if (tab.discarded === true) {
    return failure(
      "CAPTURE_PAGE_UNSUPPORTED",
      "The selected browser tab is discarded and cannot be captured without reloading it.",
      tab.url,
    );
  }
  if (tab.status === "unloaded") {
    return failure(
      "CAPTURE_PAGE_UNSUPPORTED",
      "The selected browser tab is unloaded and cannot be captured without reloading it.",
      tab.url,
    );
  }
  const pendingUrl = tab.pendingUrl?.trim();
  if ((pendingUrl !== undefined && pendingUrl.length > 0) || tab.status === "loading") {
    return failure(
      "CAPTURE_TAB_NAVIGATED",
      "The selected browser tab has a navigation in progress.",
      pendingUrl ?? tab.url,
    );
  }
  if (tab.url !== target.expectedUrl) {
    return failure(
      "CAPTURE_TAB_NAVIGATED",
      "The selected browser tab navigated before capture completed.",
      tab.url,
    );
  }
  if (!isSupportedPageUrl(target.expectedUrl)) {
    return failure(
      "CAPTURE_PAGE_UNSUPPORTED",
      "This page type cannot be captured.",
      tab.url,
    );
  }
  return undefined;
}

type IngestResult =
  | {
      status: "captured";
      receipt: ReturnType<typeof exactInstanceContentIngestResponseSchema.parse>;
    }
  | { status: "failed"; failure: ExactInstanceCaptureFailure };

function receiptMatchesTarget(
  receipt: ReturnType<typeof exactInstanceContentIngestResponseSchema.parse>,
  target: TabCommandRelayCaptureTarget,
): boolean {
  return (
    receipt.instanceId === target.instanceId &&
    receipt.browserTabId === target.tabId &&
    receipt.capturedUrl === target.expectedUrl &&
    receipt.instanceRevision === target.expectedInstanceRevision &&
    receipt.firstSeenAt === target.expectedFirstSeenAt
  );
}

async function postExactInstanceContent(
  options: ExactInstanceCaptureExecutorOptions,
  ingest: ExactInstanceContentIngest,
  executionDeadlineAt: number,
  now: () => number,
): Promise<IngestResult> {
  const body = JSON.stringify(exactInstanceContentIngestSchema.parse(ingest));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertBeforeDeadline(now, executionDeadlineAt);
    const controller = new AbortController();
    const remainingMs = Math.min(
      2_147_483_647,
      REQUEST_TIMEOUT_MS,
      Math.max(1, executionDeadlineAt - now()),
    );
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    try {
      response = await options.fetch(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tabhub-extension-origin": options.extensionOrigin(),
        },
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (now() >= executionDeadlineAt) {
        throw new TabCommandExecutionExpiredError();
      }
      if (attempt === 0) {
        continue;
      }
      return {
        status: "failed",
        failure: failure(
          "CAPTURE_INGEST_UNAVAILABLE",
          "TabHub could not reach the local capture service.",
        ),
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      clearTimeout(timeout);
      if (now() >= executionDeadlineAt) {
        throw new TabCommandExecutionExpiredError();
      }
      if (!response.ok && response.status < 500) {
        return {
          status: "failed",
          failure: failure(
            "CAPTURE_INGEST_REJECTED",
            "The local capture service rejected this capture.",
          ),
        };
      }
      if (attempt === 0) {
        continue;
      }
      return {
        status: "failed",
        failure: failure(
          response.ok
            ? "CAPTURE_INGEST_UNAVAILABLE"
            : "CAPTURE_INGEST_REJECTED",
          response.ok
            ? "TabHub could not confirm the local capture result."
            : "The local capture service returned an invalid response.",
        ),
      };
    }
    clearTimeout(timeout);
    assertBeforeDeadline(now, executionDeadlineAt);

    if (response.ok) {
      const receipt = exactInstanceContentIngestResponseSchema.safeParse(payload);
      if (receipt.success && receiptMatchesTarget(receipt.data, ingest.target)) {
        return { status: "captured", receipt: receipt.data };
      }
      return {
        status: "failed",
        failure: failure(
          "CAPTURE_INGEST_REJECTED",
          "The local capture service returned an invalid receipt.",
        ),
      };
    }

    const typedError = exactInstanceContentIngestErrorSchema.safeParse(payload);
    if (typedError.success) {
      return {
        status: "failed",
        failure: failure(
          typedError.data.error,
          typedError.data.message,
          typedError.data.observedUrl,
        ),
      };
    }
    if (response.status >= 500 && attempt === 0) {
      continue;
    }
    return {
      status: "failed",
      failure: failure(
        "CAPTURE_INGEST_REJECTED",
        "The local capture service rejected this capture.",
      ),
    };
  }

  return {
    status: "failed",
    failure: failure(
      "CAPTURE_INGEST_UNAVAILABLE",
      "TabHub could not reach the local capture service.",
    ),
  };
}

export function createExactInstanceCaptureExecutor(
  options: ExactInstanceCaptureExecutorOptions,
): (execution: ExactInstanceCaptureExecution) => Promise<TabCommandRelayResult> {
  const now = options.now ?? (() => Date.now());

  return async (execution) => {
    const { executionDeadlineAt, requestId, requestedScope, target } = execution;
    assertBeforeDeadline(now, executionDeadlineAt);
    const currentScope = await options.getCurrentScope();
    assertBeforeDeadline(now, executionDeadlineAt);
    if (currentScope === undefined || !scopesEqual(currentScope, requestedScope)) {
      return failedResult(
        target,
        failure(
          "CAPTURE_SCOPE_MISMATCH",
          "The selected tab belongs to a different browser session.",
        ),
      );
    }

    const tabBefore = await readTab(options, target);
    assertBeforeDeadline(now, executionDeadlineAt);
    if ("code" in tabBefore) {
      return failedResult(target, tabBefore);
    }
    const beforeFailure = validateTab(tabBefore, target);
    if (beforeFailure !== undefined) {
      return failedResult(target, beforeFailure);
    }

    let extractedValue: unknown;
    try {
      extractedValue = await options.extract(target.tabId);
    } catch {
      assertBeforeDeadline(now, executionDeadlineAt);
      return failedResult(
        target,
        failure(
          "CAPTURE_EXTRACTION_FAILED",
          "TabHub could not extract readable content from this page.",
        ),
      );
    }
    assertBeforeDeadline(now, executionDeadlineAt);
    const page = parseExtractedPage(extractedValue);
    if (page === undefined || page.text.trim().length === 0) {
      return failedResult(
        target,
        failure(
          "CAPTURE_EXTRACTION_FAILED",
          "The page did not provide readable content.",
        ),
      );
    }
    if (page.url !== target.expectedUrl) {
      return failedResult(
        target,
        failure(
          "CAPTURE_TAB_NAVIGATED",
          "The selected browser tab navigated while content was extracted.",
          page.url,
        ),
      );
    }

    const tabAfter = await readTab(options, target);
    assertBeforeDeadline(now, executionDeadlineAt);
    if ("code" in tabAfter) {
      return failedResult(target, tabAfter);
    }
    const afterFailure = validateTab(tabAfter, target);
    if (afterFailure !== undefined) {
      return failedResult(target, afterFailure);
    }

    assertBeforeDeadline(now, executionDeadlineAt);
    const scopeAfter = await options.getCurrentScope();
    assertBeforeDeadline(now, executionDeadlineAt);
    if (scopeAfter === undefined || !scopesEqual(scopeAfter, requestedScope)) {
      return failedResult(
        target,
        failure(
          "CAPTURE_SCOPE_MISMATCH",
          "The browser session changed while content was captured.",
        ),
      );
    }

    const outcome = await postExactInstanceContent(
      options,
      {
        ...requestedScope,
        commandRequestId: requestId,
        target,
        observedUrl: page.url,
        text: page.text,
        htmlExcerpt: page.htmlExcerpt,
      },
      executionDeadlineAt,
      now,
    );

    return tabCommandRelayResultSchema.parse({
      kind: "capture-tab-content",
      target,
      outcome,
    });
  };
}
