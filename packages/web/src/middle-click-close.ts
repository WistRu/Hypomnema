import {
  ExtensionBridgeError,
  type PhysicalTabScope,
  type PhysicalTabTarget,
  type TabCommand,
  type TabCommandResult,
  type TabMutationResult,
} from "./extension-bridge";
import type { TabCommandRoute } from "./open-tab-command-routing";

export interface MiddleClickEvent {
  button: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export function handleMiddleClickClose(
  event: MiddleClickEvent,
  close: () => void,
): boolean {
  if (event.button !== 1) return false;
  event.preventDefault();
  event.stopPropagation();
  close();
  return true;
}

export function preventMiddleClickAutoscroll(
  event: Pick<MiddleClickEvent, "button" | "preventDefault">,
): void {
  if (event.button === 1) event.preventDefault();
}

export interface SingleTabClosePlan {
  route: TabCommandRoute;
  scope: PhysicalTabScope;
  target: PhysicalTabTarget;
}

export type SingleTabCloseCommandExecutor = (
  route: TabCommandRoute,
  scope: PhysicalTabScope,
  command: Extract<TabCommand, { kind: "close-preview" | "close" }>,
) => Promise<TabCommandResult>;

function isExactTabId(ids: readonly number[], tabId: number): boolean {
  return ids.length === 1 && ids[0] === tabId;
}

/**
 * A middle click is the user's explicit confirmation for one physical tab.
 * Keep the extension's preview token and all live revalidation guarantees,
 * but do not interpose the bulk-close confirmation dialog.
 */
export async function executeSingleTabClose(
  plan: SingleTabClosePlan,
  execute: SingleTabCloseCommandExecutor,
): Promise<TabMutationResult> {
  const preview = await execute(plan.route, plan.scope, {
    intent: "explicit-single",
    kind: "close-preview",
    targets: [plan.target],
  });
  if (
    preview.kind === "close-preview" &&
    preview.skipped.some(
      ({ reason, tabId }) =>
        reason === "control-tab-protected" && tabId === plan.target.tabId,
    )
  ) {
    throw new ExtensionBridgeError(
      "The TabHub control tab is protected and cannot close itself.",
    );
  }
  if (
    preview.kind !== "close-preview" ||
    preview.requested !== 1 ||
    preview.skipped.length !== 0 ||
    !isExactTabId(preview.candidateTabIds, plan.target.tabId)
  ) {
    throw new ExtensionBridgeError(
      "This tab could not be closed by middle click. Refresh and try again.",
    );
  }

  const result = await execute(plan.route, plan.scope, {
    confirmed: true,
    kind: "close",
    previewId: preview.previewId,
  });
  if (
    result.kind !== "close" ||
    result.requested !== 1 ||
    result.failed.length !== 0 ||
    result.skipped.length !== 0 ||
    !isExactTabId(result.succeededTabIds, plan.target.tabId)
  ) {
    throw new ExtensionBridgeError(
      "The tab changed during live revalidation and was not closed.",
    );
  }
  return result;
}
