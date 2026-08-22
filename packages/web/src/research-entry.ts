import {
  canonicalResearchSelectionIds,
  researchCaptureIntentSchema,
  researchSelectionFingerprintPayload,
  type ResearchCaptureIntent,
  type ResearchTarget,
} from "@tabhub/shared";

import {
  executeExactInstanceCapture,
  type ExactCaptureRelayExecutor,
  type SelectableExactCaptureCopy,
} from "./exact-instance-capture";

export interface ResearchCaptureSelection {
  logicalPageId: number;
  copy: SelectableExactCaptureCopy;
}

export type ResearchCaptureOutcome =
  | { logicalPageId: number; tabId: number; status: "captured" }
  | { logicalPageId: number; tabId: number; status: "failed"; failureCode: string };

async function sha256Hex(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createResearchSelectionTarget(
  logicalPageIds: readonly number[],
): Promise<ResearchTarget> {
  const ids = canonicalResearchSelectionIds([...new Set(logicalPageIds)]);
  if (ids.length === 0 || ids.length > 100) {
    throw new Error("Research selection must contain 1..100 logical pages");
  }
  return {
    type: "selection",
    logicalPageIds: ids,
    fingerprint: await sha256Hex(researchSelectionFingerprintPayload(ids)),
  };
}

export async function mapCanonicalTabsToResearchTarget(
  canonicalTabIds: readonly number[],
  lookupLogicalPageId: (canonicalTabId: number) => Promise<number>,
  concurrency = 8,
): Promise<ResearchTarget> {
  const canonicalIds = [...new Set(canonicalTabIds)].sort((left, right) => left - right);
  if (canonicalIds.length === 0) {
    return createResearchSelectionTarget([]);
  }
  const logicalPageIds = new Array<number>(canonicalIds.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < canonicalIds.length) {
      const index = nextIndex++;
      logicalPageIds[index] = await lookupLogicalPageId(canonicalIds[index]!);
    }
  };
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), canonicalIds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return createResearchSelectionTarget(logicalPageIds);
}

function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && error.code.trim()) {
    return error.code;
  }
  return "CAPTURE_FAILED";
}

export async function captureResearchCopies(
  selections: readonly ResearchCaptureSelection[],
  execute: ExactCaptureRelayExecutor,
): Promise<{
  captureIntent: ResearchCaptureIntent;
  outcomes: ResearchCaptureOutcome[];
}> {
  if (selections.length > 100) {
    throw new Error("Research capture supports at most 100 logical pages");
  }
  const logicalPageIds = selections.map(({ logicalPageId }) => logicalPageId);
  if (new Set(logicalPageIds).size !== logicalPageIds.length) {
    throw new Error("Research capture requires one exact copy per logical page");
  }
  const exactTabIds = selections.map(({ copy }) => copy.instance.canonicalTabId);
  if (new Set(exactTabIds).size !== exactTabIds.length) {
    throw new Error("Research capture requires distinct exact copies");
  }

  const selectedTabIds: number[] = [];
  const knownFailures: ResearchCaptureIntent["knownFailures"] = [];
  const outcomes: ResearchCaptureOutcome[] = [];

  for (const selection of selections) {
    const tabId = selection.copy.instance.canonicalTabId;
    selectedTabIds.push(tabId);
    try {
      const outcome = await executeExactInstanceCapture(selection.copy, execute);
      if (outcome.status === "captured") {
        outcomes.push({ logicalPageId: selection.logicalPageId, tabId, status: "captured" });
      } else {
        knownFailures.push({
          logicalPageId: selection.logicalPageId,
          tabId,
          failureCode: outcome.failure.code,
        });
        outcomes.push({
          logicalPageId: selection.logicalPageId,
          tabId,
          status: "failed",
          failureCode: outcome.failure.code,
        });
      }
    } catch (error) {
      const code = failureCode(error);
      knownFailures.push({ logicalPageId: selection.logicalPageId, tabId, failureCode: code });
      outcomes.push({ logicalPageId: selection.logicalPageId, tabId, status: "failed", failureCode: code });
    }
  }

  return {
    captureIntent: researchCaptureIntentSchema.parse({ selectedTabIds, knownFailures }),
    outcomes,
  };
}
