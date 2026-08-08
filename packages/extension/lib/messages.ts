import { knownBrowserOptions } from "@tabhub/shared";

import type { KnownBrowser } from "./storage";

export type ExtensionRequest =
  | { type: "tabhub:get-status" }
  | { type: "tabhub:snapshot-now" }
  | { type: "tabhub:capture-current" }
  | { type: "tabhub:capture-all" }
  | { type: "tabhub:browser-changed"; browser: KnownBrowser };

export interface CaptureSummary {
  captured: number;
  queued: number;
  requested: number;
  skipped: number;
}

export interface ExtensionStatus {
  browserConfigured: boolean;
  deadLetterCount: number;
  lastError?: string;
  pendingOperationCount: number;
  pendingTabCount: number;
  serverReachable: boolean;
}

export type ExtensionResponse =
  | {
      ok: true;
      status: ExtensionStatus;
      capture?: CaptureSummary;
    }
  | {
      error: string;
      ok: false;
      status: ExtensionStatus;
      capture?: CaptureSummary;
    };

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const { type } = value as { type?: unknown };

  if (type === "tabhub:browser-changed") {
    const requestedBrowser = (value as { browser?: unknown }).browser;
    return (
      typeof requestedBrowser === "string" &&
      (knownBrowserOptions as readonly string[]).includes(requestedBrowser)
    );
  }

  return (
    type === "tabhub:get-status" ||
    type === "tabhub:snapshot-now" ||
    type === "tabhub:capture-current" ||
    type === "tabhub:capture-all"
  );
}
