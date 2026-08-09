import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { errorMessage } from "../lib/queue";
import {
  createBridgeResponse,
  parseBridgeRequest,
  toAppExtensionRequest,
} from "../lib/web-bridge";

const allowedOrigins = new Set([
  "http://127.0.0.1:7717",
  "http://localhost:7717",
]);

export default defineContentScript({
  matches: [
    "http://127.0.0.1:7717/app/*",
    "http://localhost:7717/app/*",
  ],
  runAt: "document_start",
  noScriptStartedPostMessage: true,
  main(ctx) {
    const targetOrigin = window.location.origin;

    if (!allowedOrigins.has(targetOrigin)) {
      return;
    }

    ctx.addEventListener(window, "message", (event) => {
      if (event.source !== window || event.origin !== targetOrigin) {
        return;
      }

      const request = parseBridgeRequest(event.data);
      if (request === undefined) {
        return;
      }

      void (async () => {
        let response: unknown;

        try {
          response = await browser.runtime.sendMessage(
            toAppExtensionRequest(request),
          );
        } catch (error) {
          response = {
            error: errorMessage(error),
            ok: false,
            type: request.type,
          };
        }

        if (ctx.isValid) {
          window.postMessage(
            createBridgeResponse(request, response),
            targetOrigin,
          );
        }
      })();
    });
  },
});
