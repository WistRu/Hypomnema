export type ExtensionRequest =
  | { type: "tabhub:get-status" }
  | { type: "tabhub:snapshot-now" }
  | { type: "tabhub:browser-changed" };

export interface ExtensionStatus {
  lastError?: string;
  pendingCount: number;
  serverReachable: boolean;
}

export type ExtensionResponse =
  | {
      ok: true;
      status: ExtensionStatus;
    }
  | {
      error: string;
      ok: false;
      status: ExtensionStatus;
    };

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const { type } = value as { type?: unknown };
  return (
    type === "tabhub:get-status" ||
    type === "tabhub:snapshot-now" ||
    type === "tabhub:browser-changed"
  );
}
