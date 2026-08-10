import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { ACTIVITY_HEARTBEAT_INTERVAL_MS } from "../lib/constants";
import {
  activityContentScriptPong,
  isActivityContentScriptPing,
  type ActivityHeartbeatSignal,
  type ActivityInteractionSignal,
} from "../lib/activity-message";

const INTERACTION_SIGNAL_THROTTLE_MS = 30_000;

export default defineContentScript({
  allFrames: true,
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main(ctx) {
    const isTopFrame = window.top === window;
    let heartbeatTimer: number | undefined;
    let lastInteractionSignalAt = Number.NEGATIVE_INFINITY;

    const sendInteraction = (): void => {
      void browser.runtime
        .sendMessage({
          kind: "interaction",
          type: "tabhub:activity-signal",
        } satisfies ActivityInteractionSignal)
        .catch(() => undefined);
    };
    const sendHeartbeat = (): void => {
      void browser.runtime
        .sendMessage({
          kind: "heartbeat",
          type: "tabhub:activity-signal",
          url: window.location.href,
        } satisfies ActivityHeartbeatSignal)
        .catch(() => undefined);
    };
    const canHeartbeat = (): boolean =>
      isTopFrame &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    const stopHeartbeat = (): void => {
      if (heartbeatTimer === undefined) return;
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const heartbeat = (): void => {
      if (!canHeartbeat()) {
        stopHeartbeat();
        return;
      }
      sendHeartbeat();
    };
    const startHeartbeat = (): void => {
      if (!canHeartbeat() || heartbeatTimer !== undefined) return;
      sendHeartbeat();
      heartbeatTimer = ctx.setInterval(
        heartbeat,
        ACTIVITY_HEARTBEAT_INTERVAL_MS,
      );
    };
    const signalInteraction = (event: Event): void => {
      if (!event.isTrusted) return;
      const now = Date.now();
      if (now - lastInteractionSignalAt < INTERACTION_SIGNAL_THROTTLE_MS) {
        return;
      }
      lastInteractionSignalAt = now;
      sendInteraction();
    };

    const handlePing = (
      message: unknown,
      _sender: unknown,
      sendResponse: (response: unknown) => void,
    ): void => {
      if (isActivityContentScriptPing(message)) {
        // Chrome 116 does not support Promise-returning onMessage listeners.
        sendResponse(activityContentScriptPong);
      }
    };
    browser.runtime.onMessage.addListener(handlePing);
    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(handlePing);
      stopHeartbeat();
    });

    for (const eventName of [
      "keydown",
      "pointerdown",
      "pointermove",
      "touchstart",
      "wheel",
    ] as const) {
      ctx.addEventListener(window, eventName, signalInteraction, {
        capture: true,
        passive: true,
      });
    }

    if (isTopFrame) {
      ctx.addEventListener(window, "focus", startHeartbeat);
      ctx.addEventListener(window, "blur", stopHeartbeat);
      ctx.addEventListener(window, "pagehide", stopHeartbeat);
      ctx.addEventListener(document, "visibilitychange", () => {
        if (canHeartbeat()) startHeartbeat();
        else stopHeartbeat();
      });
      startHeartbeat();
    }
  },
});
