import {
  tabCommandRelayLegacyProtocolVersion,
  tabCommandRelayProtocolVersion,
  tabCommandScopeSchema,
  type TabCommandRelayConnectedScope,
  type TabInstance,
  type TabListResponse,
} from "@tabhub/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import {
  executeRelayedTabCommand,
  fetchCanonicalTabInstances,
  fetchConnectedTabCommandScopes,
} from "./api";
import {
  createWindowExtensionBridge,
  ExtensionBridgeError,
  type ExtensionProbe,
  type PhysicalTabScope,
  type TabCommand,
  type TabCommandResult,
} from "./extension-bridge";
import { useI18n } from "./i18n";
import {
  executeSingleTabClose,
  type SingleTabCloseCommandExecutor,
  type SingleTabClosePlan,
} from "./middle-click-close";
import {
  canonicalTabActivationSelection,
  tabActivationAvailability,
  type CanonicalTabActivationSelection,
  type TabActivationTranslator,
} from "./open-tab-activation";

type SingleTabCloseRequest =
  | { canonicalTabId: number; kind: "canonical" }
  | { kind: "physical"; tab: TabInstance };

export interface SingleTabCloseController {
  busy: boolean;
  closeCanonical(canonicalTabId: number): void;
  closePhysical(tab: TabInstance): void;
  errorForCanonical(canonicalTabId: number): unknown | undefined;
  errorForPhysical(instanceId: number): unknown | undefined;
  isClosingCanonical(canonicalTabId: number): boolean;
  isClosingPhysical(instanceId: number): boolean;
}

function unavailableProbe(): ExtensionProbe {
  return {
    available: false,
    browser: null,
    browserSessionId: null,
    controlWindowId: null,
    installationId: null,
    pendingUndos: [],
    windows: [],
  };
}

function planForTab(
  tab: TabInstance,
  probe: ExtensionProbe,
  connectedScopes: readonly PhysicalTabScope[],
  translate: (key: string) => string,
): SingleTabClosePlan {
  const availability = tabActivationAvailability(
    tab,
    probe,
    translate,
    connectedScopes,
  );
  if (availability.kind !== "ready") {
    throw new ExtensionBridgeError(availability.message);
  }
  const scope = tabCommandScopeSchema.parse({
    browser: availability.target.browser,
    browserSessionId: availability.target.browserSessionId,
    installationId: availability.target.installationId,
  });
  return {
    route: availability.route,
    scope,
    target: {
      expectedUrl: tab.url,
      tabId: availability.target.tabId,
    },
  };
}

function sameScope(
  left: PhysicalTabScope,
  right: PhysicalTabScope,
): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

const LEGACY_SINGLE_CLOSE_MESSAGE =
  "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.";

function directProbeSupportsSingleClose(
  probe: ExtensionProbe | undefined,
  connectedScopes: readonly TabCommandRelayConnectedScope[],
): boolean {
  if (probe?.available !== true || probe.browser === null) return false;
  const probeScope: PhysicalTabScope = {
    browser: probe.browser,
    browserSessionId: probe.browserSessionId,
    installationId: probe.installationId,
  };
  return (
    (probe.commandProtocolVersion ?? tabCommandRelayLegacyProtocolVersion) ===
      tabCommandRelayProtocolVersion ||
    connectedScopes.some(
      (scope) =>
        sameScope(scope, probeScope) &&
        scope.protocolVersion === tabCommandRelayProtocolVersion,
    )
  );
}

/**
 * Closing a canonical record may choose among several physical copies. Keep
 * activation compatible with v3, but prefer a copy whose relay understands
 * the explicit-single close contract. Falling back to all scopes lets the
 * caller surface a precise upgrade error when only a legacy copy is reachable.
 */
export function canonicalSingleTabCloseSelection(
  tabs: readonly TabInstance[],
  probe: ExtensionProbe | undefined,
  connectedScopes: readonly TabCommandRelayConnectedScope[],
  translate?: TabActivationTranslator,
): CanonicalTabActivationSelection {
  const directProbe =
    directProbeSupportsSingleClose(probe, connectedScopes)
      ? probe
      : undefined;
  const capableSelection = canonicalTabActivationSelection(
    tabs,
    directProbe,
    translate,
    connectedScopes.filter(
      ({ protocolVersion }) =>
        protocolVersion === tabCommandRelayProtocolVersion,
    ),
  );
  return capableSelection.kind === "ready"
    ? capableSelection
    : canonicalTabActivationSelection(
        tabs,
        probe,
        translate,
        connectedScopes,
      );
}

export async function executeSingleTabCloseForConnectedScopes(
  plan: SingleTabClosePlan,
  probe: ExtensionProbe,
  connectedScopes: readonly TabCommandRelayConnectedScope[],
  execute: SingleTabCloseCommandExecutor,
  translate: TabActivationTranslator = (key) => key,
) {
  const selectedDirect =
    plan.route === "direct" &&
    probe.available &&
    probe.browser !== null &&
    sameScope(
      {
        browser: probe.browser,
        browserSessionId: probe.browserSessionId,
        installationId: probe.installationId,
      },
      plan.scope,
    )
      ? probe
      : undefined;
  const selectedRelay =
    plan.route === "relay"
      ? connectedScopes.find((scope) => sameScope(scope, plan.scope))
      : undefined;
  if (
    (selectedDirect !== undefined &&
      !directProbeSupportsSingleClose(selectedDirect, connectedScopes)) ||
    (selectedRelay !== undefined &&
      selectedRelay.protocolVersion !== tabCommandRelayProtocolVersion)
  ) {
    throw new Error(translate(LEGACY_SINGLE_CLOSE_MESSAGE));
  }
  return executeSingleTabClose(plan, execute);
}

function closeCommand(
  command: TabCommand,
): asserts command is Extract<
  TabCommand,
  { kind: "close-preview" | "close" }
> {
  if (command.kind !== "close-preview" && command.kind !== "close") {
    throw new ExtensionBridgeError("Expected one addressed close command.");
  }
}

function updateCanonicalTabCachesAfterClose(
  queryClient: QueryClient,
  closedTab: TabInstance,
  remainingInstances: readonly TabInstance[] | undefined,
): void {
  const closedAt = new Date().toISOString();
  for (const [queryKey, current] of queryClient.getQueriesData<TabListResponse>({
    queryKey: ["tabs"],
  })) {
    if (current === undefined) continue;
    const filters =
      typeof queryKey[1] === "object" && queryKey[1] !== null
        ? (queryKey[1] as {
            duplicatesOnly?: boolean;
            openState?: "all" | "closed" | "open";
          })
        : {};
    let removed = 0;
    const items = current.items.flatMap((item) => {
      if (item.id !== closedTab.canonicalTabId) return [item];
      const openInstanceCount =
        remainingInstances?.length ?? Math.max(0, item.openInstanceCount - 1);
      const isOpen = openInstanceCount > 0;
      const openEngagedTimeMs =
        remainingInstances?.reduce(
          (total, instance) => total + instance.engagedTimeMs,
          0,
        ) ??
        Math.max(0, item.openEngagedTimeMs - closedTab.engagedTimeMs);
      const openForegroundTimeMs =
        remainingInstances?.reduce(
          (total, instance) => total + instance.foregroundTimeMs,
          0,
        ) ??
        Math.max(0, item.openForegroundTimeMs - closedTab.foregroundTimeMs);
      const updated = {
        ...item,
        closedAt: isOpen ? item.closedAt : closedAt,
        index: isOpen ? item.index : null,
        isOpen,
        openEngagedTimeMs,
        openForegroundTimeMs,
        openInstanceCount,
        windowId: isOpen ? item.windowId : null,
      };
      const noLongerMatches =
        (filters.duplicatesOnly === true && openInstanceCount <= 1) ||
        (filters.openState === "open" && !isOpen) ||
        (filters.openState === "closed" && isOpen);
      if (noLongerMatches) {
        removed += 1;
        return [];
      }
      return [updated];
    });
    if (
      removed > 0 ||
      items.some((item, index) => item !== current.items[index])
    ) {
      queryClient.setQueryData<TabListResponse>(queryKey, {
        ...current,
        items,
        total: Math.max(0, current.total - removed),
      });
    }
  }
}

function resolvedRemainingInstances(
  queryClient: QueryClient,
  closedTab: TabInstance,
): readonly TabInstance[] | undefined {
  const candidates = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["tab-instances"] })
    .flatMap((query) => {
      const key = query.queryKey;
      const second = key[1];
      const exactCanonicalQuery =
        typeof second === "object" &&
        second !== null &&
        "canonicalTabId" in second &&
        second.canonicalTabId === closedTab.canonicalTabId;
      const libraryQuery = second === "library";
      if (!exactCanonicalQuery && !libraryQuery) return [];
      const instances = query.state.data;
      if (
        !Array.isArray(instances) ||
        !instances.some(
          (instance) =>
            typeof instance === "object" &&
            instance !== null &&
            "instanceId" in instance &&
            instance.instanceId === closedTab.instanceId,
        )
      ) {
        return [];
      }
      return [
        {
          dataUpdatedAt: query.state.dataUpdatedAt,
          instances: instances as TabInstance[],
          priority:
            (query.getObserversCount() > 0 ? 2 : 0) +
            (exactCanonicalQuery ? 1 : 0),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.dataUpdatedAt - left.dataUpdatedAt,
    );
  return candidates[0]?.instances.filter(
    ({ canonicalTabId, instanceId }) =>
      canonicalTabId === closedTab.canonicalTabId &&
      instanceId !== closedTab.instanceId,
  );
}

export function useSingleTabClose(): SingleTabCloseController {
  const { t } = useI18n();
  const bridge = useMemo(() => createWindowExtensionBridge(), []);
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const probeQuery = useQuery({
    queryKey: ["extension-bridge", "probe"],
    queryFn: () => bridge.probe(),
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 10_000,
  });
  const relayScopesQuery = useQuery({
    queryKey: ["tab-command-relay", "scopes"],
    queryFn: ({ signal }) => fetchConnectedTabCommandScopes(signal),
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 3_000,
  });

  const execute: SingleTabCloseCommandExecutor = async (
    route,
    scope,
    command,
  ) => {
    closeCommand(command);
    if (route === "direct") {
      const response = await bridge.command({ ...scope, command });
      if (!sameScope(response, scope)) {
        throw new ExtensionBridgeError(
          "The extension browser session changed during the action.",
        );
      }
      return response.result;
    }

    const relayScope = tabCommandScopeSchema.parse(scope);
    const result = await executeRelayedTabCommand({
      ...relayScope,
      command,
    });
    if (result.kind !== "close-preview" && result.kind !== "close") {
      throw new ExtensionBridgeError(
        "The extension returned a result for a different command.",
      );
    }
    return result as TabCommandResult;
  };

  const mutation = useMutation({
    mutationFn: async (request: SingleTabCloseRequest) => {
      const tabsPromise =
        request.kind === "canonical"
          ? fetchCanonicalTabInstances(request.canonicalTabId)
          : Promise.resolve([request.tab]);
      const [tabs, probe, connectedScopes] = await Promise.all([
        tabsPromise,
        probeQuery.data === undefined
          ? bridge.probe().catch(() => unavailableProbe())
          : Promise.resolve(probeQuery.data),
        relayScopesQuery.data === undefined
          ? fetchConnectedTabCommandScopes().catch(
              (): TabCommandRelayConnectedScope[] => [],
            )
          : Promise.resolve(relayScopesQuery.data),
      ]);

      let closedTab: TabInstance;
      let plan: SingleTabClosePlan;
      if (request.kind === "canonical") {
        const selection = canonicalSingleTabCloseSelection(
          tabs,
          probe,
          connectedScopes,
          t,
        );
        if (selection.kind !== "ready") {
          throw new ExtensionBridgeError(selection.message);
        }
        closedTab = selection.tab;
        plan = planForTab(closedTab, probe, connectedScopes, t);
      } else {
        closedTab = request.tab;
        plan = planForTab(closedTab, probe, connectedScopes, t);
      }

      const result = await executeSingleTabCloseForConnectedScopes(
        plan,
        probe,
        connectedScopes,
        execute,
        t,
      );
      return { closedTab, result };
    },
    onSuccess: ({ closedTab }) => {
      const remainingInstances = resolvedRemainingInstances(
        queryClient,
        closedTab,
      );
      const removeClosedCopy = (instances: TabInstance[] | undefined) =>
        instances?.filter(
          ({ instanceId }) => instanceId !== closedTab.instanceId,
        );
      queryClient.setQueriesData<TabInstance[]>(
        { queryKey: ["tab-instances", "library"] },
        removeClosedCopy,
      );
      queryClient.setQueryData<TabInstance[]>(
        ["tab-instances", { canonicalTabId: closedTab.canonicalTabId }],
        removeClosedCopy,
      );
      updateCanonicalTabCachesAfterClose(
        queryClient,
        closedTab,
        remainingInstances,
      );
    },
    onSettled: async (result, _error, request) => {
      const canonicalTabId =
        request.kind === "canonical"
          ? request.canonicalTabId
          : request.tab.canonicalTabId;
      try {
        await Promise.all([
          ...(result === undefined
            ? [
                queryClient.invalidateQueries({
                  queryKey: ["tab-instances"],
                }),
              ]
            : []),
          queryClient.invalidateQueries({ queryKey: ["tabs"] }),
          queryClient.invalidateQueries({ queryKey: ["duplicate-groups"] }),
          queryClient.invalidateQueries({ queryKey: ["graph"] }),
          queryClient.invalidateQueries({
            queryKey: ["extension-bridge", "probe"],
          }),
          queryClient.invalidateQueries({
            queryKey: ["tab-command-relay", "browser-state"],
          }),
          queryClient.invalidateQueries({
            queryKey: ["tab", canonicalTabId],
          }),
        ]);
      } finally {
        inFlight.current = false;
      }
    },
  });

  const run = (request: SingleTabCloseRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate(request);
  };
  const matches = (request: SingleTabCloseRequest): boolean => {
    const current = mutation.variables;
    if (current?.kind !== request.kind) return false;
    if (request.kind === "canonical") {
      return (
        current.kind === "canonical" &&
        current.canonicalTabId === request.canonicalTabId
      );
    }
    return (
      current.kind === "physical" &&
      current.tab.instanceId === request.tab.instanceId
    );
  };

  return {
    busy: mutation.isPending,
    closeCanonical: (canonicalTabId) =>
      run({ canonicalTabId, kind: "canonical" }),
    closePhysical: (tab) => run({ kind: "physical", tab }),
    errorForCanonical: (canonicalTabId) =>
      mutation.isError && matches({ canonicalTabId, kind: "canonical" })
        ? mutation.error
        : undefined,
    errorForPhysical: (instanceId) =>
      mutation.isError &&
      mutation.variables?.kind === "physical" &&
      mutation.variables.tab.instanceId === instanceId
        ? mutation.error
        : undefined,
    isClosingCanonical: (canonicalTabId) =>
      mutation.isPending && matches({ canonicalTabId, kind: "canonical" }),
    isClosingPhysical: (instanceId) =>
      mutation.isPending &&
      mutation.variables?.kind === "physical" &&
      mutation.variables.tab.instanceId === instanceId,
  };
}
