import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { createLocalPairingChallenge, fetchFeatureFlags } from "./api";
import {
  createWindowExtensionBridge,
  ExtensionBridgeTimeoutError,
} from "./extension-bridge";
import { useI18n } from "./i18n";

type PairingChallenge = Awaited<ReturnType<typeof createLocalPairingChallenge>>;

/**
 * "unknown" is not a failure: the handover may have landed after the page gave
 * up waiting, so the challenge cannot be offered as if it were still spendable.
 */
export type PairingOutcome =
  | { status: "paired" }
  | { challenge: PairingChallenge; status: "manual" }
  | { status: "unknown" };

interface PairBrowserProps {
  /**
   * "banner" is the unprompted offer at the top of the app and appears only
   * when the extension positively reports itself unpaired. "panel" is the
   * deliberate control inside personal context and appears whenever an
   * extension is reachable, including when it is too old to report at all.
   */
  variant: "banner" | "panel";
}

export function PairBrowser({ variant }: PairBrowserProps) {
  const { errorMessage, formatDate, t } = useI18n();
  const queryClient = useQueryClient();
  const bridge = useMemo(
    () => (typeof window === "undefined" ? null : createWindowExtensionBridge()),
    [],
  );
  const featuresQuery = useQuery({
    queryKey: ["features"],
    queryFn: ({ signal }) => fetchFeatureFlags(signal),
    staleTime: 30_000,
  });
  const enabled = featuresQuery.data?.context === true;
  const probeQuery = useQuery({
    queryKey: ["extension-bridge", "probe"],
    queryFn: () => bridge!.probe(),
    enabled: enabled && bridge !== null,
    retry: false,
    staleTime: 10_000,
  });
  const probe = probeQuery.data?.available ? probeQuery.data : null;

  const pairing = useMutation({
    mutationFn: async (input: {
      extensionOrigin: string;
      installationId: string;
    }): Promise<PairingOutcome> => {
      const challenge = await createLocalPairingChallenge(input);
      if (bridge === null) return { challenge, status: "manual" };
      try {
        await bridge.pair({
          challengeId: challenge.challengeId,
          code: challenge.code,
          installationId: input.installationId,
        });
      } catch (error) {
        // A refusal is an answer: the challenge was not consumed and is still
        // spendable, so showing it is a real fallback. A timeout is not an
        // answer — the extension may have consumed it after we stopped
        // waiting, and a spent code sends the user to retype something that
        // cannot work and burns a failed attempt doing it.
        return error instanceof ExtensionBridgeTimeoutError
          ? { status: "unknown" }
          : { challenge, status: "manual" };
      }
      return { status: "paired" };
    },
    onSuccess: async (outcome) => {
      if (outcome.status !== "paired") return;
      // Prefix keys: the panel refreshes `["personal-context", tabId]` for one
      // tab, but pairing unlocks personal context everywhere, so every tab's
      // context and the tab list itself are stale.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["extension-bridge"] }),
        queryClient.invalidateQueries({ queryKey: ["personal-context"] }),
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      ]);
    },
  });

  if (!probe?.extensionOrigin) return null;
  // An extension too old to report `paired` leaves it undefined. Offering an
  // unprompted banner on a guess would nag an already paired browser, so the
  // banner speaks only when the extension positively says it is unpaired.
  if (variant === "banner" && probe.paired !== false) return null;

  const outcome = pairing.data;

  return (
    <div className={variant === "banner" ? "pairing-banner" : "context-pairing"}>
      {outcome === undefined ? (
        <p className="muted-copy">
          {variant === "banner"
            ? t("This browser is not connected to personal context yet.")
            : t("One-time step for this browser. Pairing does not expire.")}
        </p>
      ) : null}
      <button
        disabled={pairing.isPending}
        type="button"
        onClick={() =>
          pairing.mutate({
            extensionOrigin: probe.extensionOrigin!,
            installationId: probe.installationId,
          })
        }
      >
        {t("Pair this browser for personal context")}
      </button>
      {outcome === undefined ? null : (
        <div role="status">
          {outcome.status === "paired" ? (
            <p>{t("This browser is paired.")}</p>
          ) : outcome.status === "unknown" ? (
            <p>
              {t(
                "TabHub could not tell whether this browser was paired. Check the extension window, then reload this page.",
              )}
            </p>
          ) : (
            <>
              <p>
                {t(
                  "This browser could not be paired automatically. Enter these in the extension window instead.",
                )}
              </p>
              <p>
                {t("Pairing challenge")}: <code>{outcome.challenge.challengeId}</code>
              </p>
              <p>
                {t("Pairing code")}: <code>{outcome.challenge.code}</code>
              </p>
              <p>
                {t("Expires {date}", {
                  date: formatDate(outcome.challenge.expiresAt),
                })}
              </p>
            </>
          )}
          <button type="button" onClick={() => pairing.reset()}>
            {t("OK")}
          </button>
        </div>
      )}
      {pairing.error ? (
        <p className="drawer-error" role="alert">
          {errorMessage(pairing.error)}
        </p>
      ) : null}
    </div>
  );
}
