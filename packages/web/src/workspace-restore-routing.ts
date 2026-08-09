import type { TabCommandScope } from "@tabhub/shared";

import { isRelayedTabCommandOutcomeUnknown } from "./api";
import {
  ExtensionBridgeTimeoutError,
  type MoveDestination,
} from "./extension-bridge";

export interface WorkspaceCommandTarget {
  direct: boolean;
  label: string;
  scope: TabCommandScope;
}

export type WorkspaceRestoreDestination = Extract<
  MoveDestination,
  { kind: "app-window" | "new-window" }
>;

export function workspaceRestoreDestination(
  direct: boolean,
  destination: MoveDestination,
): WorkspaceRestoreDestination | null {
  if (destination.kind === "new-window") return destination;
  if (destination.kind === "app-window" && direct) return destination;
  return null;
}

export function isWorkspaceRestoreOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof ExtensionBridgeTimeoutError ||
    isRelayedTabCommandOutcomeUnknown(error)
  );
}
