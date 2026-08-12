import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { forgetRetentionTab, setRetentionDecision } from "./api";
import { useI18n } from "./i18n";
import {
  retentionBlockedMessageKey,
  RETENTION_FORGET_CONFIRMATION,
} from "./retention-ui";

interface PageRetentionActionsProps {
  onForgotten: () => void;
  tabId: number;
}

export function PageRetentionActions({
  onForgotten,
  tabId,
}: PageRetentionActionsProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatNumber, t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retention"] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({ queryKey: ["tab", tabId] }),
      queryClient.invalidateQueries({ queryKey: ["tab-instances"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["graph"] }),
    ]);
  };

  const decisionMutation = useMutation({
    mutationFn: (decision: "keep" | "later") =>
      setRetentionDecision(tabId, decision),
    onMutate: () => {
      setMessage(null);
      setIsError(false);
    },
    onSuccess: (result) => {
      setMessage(
        t(
          result.decision === "keep"
            ? "This page will stay in the Library."
            : "This page will return to review later.",
        ),
      );
      void refresh();
    },
    onError: (error) => {
      setIsError(true);
      setMessage(errorMessage(error));
    },
  });

  const forgetMutation = useMutation({
    mutationFn: () => forgetRetentionTab(tabId),
    onMutate: () => {
      setMessage(null);
      setIsError(false);
    },
    onSuccess: (result) => {
      if (result.outcome === "blocked") {
        setIsError(true);
        const baseMessage = t(retentionBlockedMessageKey(result.reason));
        setMessage(
          result.closedInstanceCount > 0
            ? `${baseMessage} ${t(
                "{count} copies were already closed; the page remains in the Library.",
                { count: formatNumber(result.closedInstanceCount) },
              )}`
            : baseMessage,
        );
        void refresh();
        return;
      }
      void refresh();
      onForgotten();
    },
    onError: (error) => {
      setIsError(true);
      setMessage(errorMessage(error));
    },
  });

  const busy = decisionMutation.isPending || forgetMutation.isPending;

  return (
    <div className="retention-drawer-actions">
      <p>
        {t(
          "Your decision is personal to this page. TabHub will never delete it from a suggestion alone.",
        )}
      </p>
      <div>
        <button
          disabled={busy}
          type="button"
          onClick={() => decisionMutation.mutate("keep")}
        >
          {t("Keep")}
        </button>
        <button
          disabled={busy}
          type="button"
          onClick={() => decisionMutation.mutate("later")}
        >
          {t("Later")}
        </button>
        <button
          className="danger-button"
          disabled={busy}
          type="button"
          onClick={() => {
            if (window.confirm(t(RETENTION_FORGET_CONFIRMATION))) {
              forgetMutation.mutate();
            }
          }}
        >
          {forgetMutation.isPending
            ? t("Closing copies...")
            : t("Close and forget")}
        </button>
      </div>
      {message ? (
        <p
          aria-label={isError ? message : undefined}
          className={isError ? "retention-action-message is-error" : "retention-action-message"}
          role={isError ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
