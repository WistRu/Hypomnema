import {
  tabCommandScopeSchema,
  type ForgetRetention,
  type RestoreRetention,
  type RetentionDecisionResponse,
  type RetentionForgetResponse,
  type RetentionReviewResponse,
  type RetentionTrashResponse,
  type SetRetentionDecision,
  type TabCommandRelayClosePreviewTarget,
  type TabCommandRelayHttpResponse,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";

import type { RetentionCatalog } from "./retention-catalog.js";
import type { TabCommandRelay } from "./tab-command-relay.js";
import type { TabInstanceCatalog } from "./tab-instance-catalog.js";

export interface RetentionLifecycle {
  decide(
    tabId: number,
    input: SetRetentionDecision,
  ): RetentionDecisionResponse;
  forget(
    tabId: number,
    input: ForgetRetention,
  ): Promise<RetentionForgetResponse>;
  listTrash(input: { page: number; pageSize: number }): RetentionTrashResponse;
  restore(tabId: number, input: RestoreRetention): RetentionDecisionResponse;
  review(input: { page: number; pageSize: number }): RetentionReviewResponse;
}

interface ScopePlan {
  scope: TabCommandScope;
  targets: TabCommandRelayClosePreviewTarget[];
}

function exactIds(actual: number[], expected: number[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return (
    expectedSet.size === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expectedSet.has(id))
  );
}

function blockReason(
  response: TabCommandRelayHttpResponse,
): RetentionForgetResponse["reason"] {
  if (!response.ok) {
    if (response.error === "SCOPE_OFFLINE") return "scope_offline";
    if (response.outcome === "unknown") return "outcome_unknown";
  }
  return "close_incomplete";
}

function plansForInstances(instances: TabInstance[]): ScopePlan[] | undefined {
  const plans = new Map<string, ScopePlan>();
  for (const instance of instances) {
    const parsedScope = tabCommandScopeSchema.safeParse({
      browser: instance.browser,
      installationId: instance.installationId,
      browserSessionId: instance.browserSessionId,
    });
    if (!parsedScope.success || instance.browserTabId === null) {
      return undefined;
    }
    const scope = parsedScope.data;
    const key = `${scope.browser}\u0000${scope.installationId}\u0000${scope.browserSessionId}`;
    const plan = plans.get(key) ?? { scope, targets: [] };
    plan.targets.push({
      expectedUrl: instance.url,
      tabId: instance.browserTabId,
    });
    plans.set(key, plan);
  }
  return [...plans.values()];
}

export function createRetentionLifecycle(options: {
  catalog: RetentionCatalog;
  relay: TabCommandRelay;
  tabInstanceCatalog: TabInstanceCatalog;
}): RetentionLifecycle {
  return {
    decide: (tabId, input) => options.catalog.decide(tabId, input),

    async forget(tabId, input) {
      const initialInstances = options.tabInstanceCatalog.listAllInstances({
        browser: undefined,
        canonicalTabId: tabId,
        duplicatesOnly: false,
        q: undefined,
      }).items;
      if (initialInstances.length === 0) {
        const trashed = options.catalog.decide(tabId, {
          decision: "trash",
          decidedBy: input.decidedBy,
          confirmed: true,
        });
        return {
          tabId,
          outcome: "trashed",
          reason: null,
          closedInstanceCount: 0,
          purgeAt: trashed.purgeAt,
        };
      }

      const plans = plansForInstances(initialInstances);
      if (plans === undefined) {
        return {
          tabId,
          outcome: "blocked",
          reason: "unaddressable_instance",
          closedInstanceCount: 0,
          purgeAt: null,
        };
      }

      const previews: Array<{ plan: ScopePlan; previewId: string }> = [];
      for (const plan of plans) {
        const response = await options.relay.dispatch({
          ...plan.scope,
          command: { kind: "close-preview", targets: plan.targets },
        });
        if (!response.ok) {
          return {
            tabId,
            outcome: "blocked",
            reason: blockReason(response),
            closedInstanceCount: 0,
            purgeAt: null,
          };
        }
        const result = response.result;
        const expectedIds = plan.targets.map(({ tabId: targetId }) => targetId);
        if (
          result.kind !== "close-preview" ||
          result.requested !== expectedIds.length ||
          result.skipped.length > 0 ||
          !exactIds(result.candidateTabIds, expectedIds)
        ) {
          return {
            tabId,
            outcome: "blocked",
            reason: "preview_changed",
            closedInstanceCount: 0,
            purgeAt: null,
          };
        }
        previews.push({ plan, previewId: result.previewId });
      }

      let closedInstanceCount = 0;
      for (const { plan, previewId } of previews) {
        const response = await options.relay.dispatch({
          ...plan.scope,
          command: { kind: "close", previewId, confirmed: true },
        });
        if (!response.ok) {
          return {
            tabId,
            outcome: "blocked",
            reason: blockReason(response),
            closedInstanceCount,
            purgeAt: null,
          };
        }
        const result = response.result;
        const expectedIds = plan.targets.map(({ tabId: targetId }) => targetId);
        const returnedIds =
          result.kind === "close"
            ? [
                ...result.succeededTabIds,
                ...result.skipped.map(({ tabId: targetId }) => targetId),
                ...result.failed.map(({ tabId: targetId }) => targetId),
              ]
            : [];
        const correlatedPartition =
          result.kind === "close" && exactIds(returnedIds, expectedIds);
        if (
          result.kind !== "close" ||
          result.requested !== expectedIds.length ||
          result.failed.length > 0 ||
          result.skipped.length > 0 ||
          !exactIds(result.succeededTabIds, expectedIds)
        ) {
          return {
            tabId,
            outcome: "blocked",
            reason: "close_incomplete",
            closedInstanceCount:
              closedInstanceCount +
              (correlatedPartition ? result.succeededTabIds.length : 0),
            purgeAt: null,
          };
        }
        closedInstanceCount += result.succeededTabIds.length;
      }

      const remaining = options.tabInstanceCatalog.listAllInstances({
        browser: undefined,
        canonicalTabId: tabId,
        duplicatesOnly: false,
        q: undefined,
      }).total;
      if (remaining > 0) {
        return {
          tabId,
          outcome: "blocked",
          reason: "instances_remain",
          closedInstanceCount,
          purgeAt: null,
        };
      }

      const trashed = options.catalog.decide(tabId, {
        decision: "trash",
        decidedBy: input.decidedBy,
        confirmed: true,
      });
      return {
        tabId,
        outcome: "trashed",
        reason: null,
        closedInstanceCount,
        purgeAt: trashed.purgeAt,
      };
    },

    listTrash: (input) => options.catalog.listTrash(input),
    restore: (tabId, input) => options.catalog.restore(tabId, input),
    review: (input) => options.catalog.review(input),
  };
}
