import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

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
} from "./extension-bridge";
import {
  canonicalTabBrowserActionSelection,
  type CanonicalTabBrowserActionRequest,
  executeTabActivation,
} from "./open-tab-activation";

export interface CanonicalTabActivationController {
  run(request: CanonicalTabBrowserActionRequest): void;
  busy: boolean;
  errorFor(canonicalTabId: number): unknown | undefined;
  isActivating(canonicalTabId: number): boolean;
}

export function openConfirmedClosedUrl(url: string): void {
  const opened = window.open("about:blank", "_blank");
  if (opened === null) {
    throw new ExtensionBridgeError(
      "The tab is closed, but the browser blocked opening it. Try again.",
    );
  }
  opened.opener = null;
  opened.location.replace(url);
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

export function useCanonicalTabActivation(): CanonicalTabActivationController {
  const bridge = useMemo(() => createWindowExtensionBridge(), []);
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

  const activationMutation = useMutation({
    mutationFn: async (request: CanonicalTabBrowserActionRequest) => {
      // Resolve first so a confirmed-closed URL does not wait for a bridge
      // timeout and lose the browser's transient click activation.
      const tabs = await fetchCanonicalTabInstances(request.canonicalTabId);
      if (tabs.length === 0) {
        const selection = canonicalTabBrowserActionSelection(
          tabs,
          request,
          undefined,
        );
        if (selection.kind === "open-new") {
          openConfirmedClosedUrl(selection.url);
          return selection;
        }
        if (selection.kind === "unavailable") {
          throw new ExtensionBridgeError(selection.message);
        }
        throw new ExtensionBridgeError(
          "TabHub returned an unexpected open-tab target.",
        );
      }

      const [probe, connectedScopes] = await Promise.all([
        probeQuery.data === undefined
          ? bridge.probe().catch(() => unavailableProbe())
          : Promise.resolve(probeQuery.data),
        relayScopesQuery.data === undefined
          ? fetchConnectedTabCommandScopes().catch(
              (): PhysicalTabScope[] => [],
            )
          : Promise.resolve(relayScopesQuery.data),
      ]);
      const selection = canonicalTabBrowserActionSelection(
        tabs,
        request,
        probe,
        undefined,
        connectedScopes,
      );
      if (selection.kind === "open-new") {
        openConfirmedClosedUrl(selection.url);
        return selection;
      }
      if (selection.kind !== "ready") {
        throw new ExtensionBridgeError(selection.message);
      }

      return executeTabActivation(selection.activation, {
        direct: (target) => bridge.activate(target),
        relay: executeRelayedTabCommand,
      });
    },
    onError: () => {
      void Promise.allSettled([
        probeQuery.refetch(),
        relayScopesQuery.refetch(),
      ]);
    },
  });

  return {
    run: (request) => activationMutation.mutate(request),
    busy: activationMutation.isPending,
    errorFor: (canonicalTabId) =>
      activationMutation.isError &&
      activationMutation.variables?.canonicalTabId === canonicalTabId
        ? activationMutation.error
        : undefined,
    isActivating: (canonicalTabId) =>
      activationMutation.isPending &&
      activationMutation.variables?.canonicalTabId === canonicalTabId,
  };
}
