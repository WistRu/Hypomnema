// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const popupBrowser = vi.hoisted(() => ({
  contextEnabled: true,
  staleContextQueue: false,
  i18n: {
    getMessage: vi.fn((name: string) => (name === "@@ui_locale" ? "en" : name)),
  },
  runtime: {
    openOptionsPage: vi.fn(async () => undefined),
    sendMessage: vi.fn(
      async (request: Record<string, unknown> & { type: string }) => {
        const status = {
          browserConfigured: true,
          deadLetterCount: 0,
          pendingOperationCount: 0,
          pendingTabCount: 0,
          serverReachable: true,
        };
        if (request.type === "tabhub:get-status") return { ok: true, status };
        if (
          request.type === "tabhub:context-features" ||
          request.type === "tabhub:context-discard-stale"
        ) {
          if (request.type === "tabhub:context-discard-stale") {
            popupBrowser.staleContextQueue = false;
          }
          return {
            context: {
              activeTab: {
                id: 13,
                title: "Article",
                url: "https://example.com/article",
              },
              browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
              contextEnabled: popupBrowser.contextEnabled,
              installationId: "123e4567-e89b-42d3-a456-426614174000",
              mutationTarget: {
                expectedUrl: "https://example.com/article",
                scope: {
                  browserSessionId:
                    "223e4567-e89b-42d3-a456-426614174000",
                  browserTabId: 13,
                  installationId:
                    "123e4567-e89b-42d3-a456-426614174000",
                },
              },
              pairingRequired: false,
              ...(popupBrowser.staleContextQueue
                ? {
                    pendingMutationError: "Page changed; review required",
                    pendingMutationHeadId: "stale-head-id",
                  }
                : {}),
              pendingMutationCount: popupBrowser.staleContextQueue ? 2 : 0,
              sessionIntent: {
                current: {
                  body: "Compare A",
                  expectedPage: {
                    instanceRevision: 1,
                    logicalPageId: 17,
                    url: "https://example.com/article",
                    urlNormalized: "https://example.com/article",
                  },
                  id: 7,
                  scope: {
                    browserSessionId:
                      "223e4567-e89b-42d3-a456-426614174000",
                    browserTabId: 13,
                    installationId:
                      "123e4567-e89b-42d3-a456-426614174000",
                  },
                  state: "active",
                },
                history: [{ body: "Older note", id: 6, state: "archived" }],
              },
            },
            ok: true,
            status,
          };
        }
        if (request.type === "tabhub:context-save") {
          return { error: "Retry required", ok: false, status };
        }
        if (request.type === "tabhub:context-intent-action") {
          return {
            context: {
              activeTab: null,
              browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
              contextEnabled: true,
              installationId: "123e4567-e89b-42d3-a456-426614174000",
              pairingRequired: false,
              pendingMutationCount: 0,
            },
            ok: true,
            status,
          };
        }
        throw new Error(`Unexpected request: ${request.type}`);
      },
    ),
  },
}));

vi.mock("wxt/browser", () => ({ browser: popupBrowser }));

let popupModule: typeof import("../entrypoints/popup/main");

beforeAll(async () => {
  const html = await readFile(
    resolve(process.cwd(), "entrypoints/popup/index.html"),
    "utf8",
  );
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1];
  if (body === undefined) throw new Error("Popup body fixture is missing");
  document.body.innerHTML = body;
  popupModule = await import("../entrypoints/popup/main");
});

beforeEach(() => {
  popupBrowser.contextEnabled = true;
  popupBrowser.staleContextQueue = false;
});

describe("personal-context popup runtime", () => {
  it("reveals feature-enabled UI and preserves text when a save fails", async () => {
    await popupModule.refreshContext();
    const section = document.querySelector<HTMLElement>("#context-section")!;
    const form = document.querySelector<HTMLFormElement>("#context-form")!;
    const body = document.querySelector<HTMLTextAreaElement>("#context-body")!;
    await vi.waitFor(() => expect(section.hidden).toBe(false));
    expect(form.hidden).toBe(false);

    body.value = "Keep this draft after failure";
    form.requestSubmit();
    await vi.waitFor(() =>
      expect(popupBrowser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Keep this draft after failure",
          expectedUrl: "https://example.com/article",
          targetScope: expect.objectContaining({ browserTabId: 13 }),
          type: "tabhub:context-save",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("#context-feedback")?.textContent).toBe(
        "Retry required",
      ),
    );
    expect(body.value).toBe("Keep this draft after failure");

    form.requestSubmit();
    await vi.waitFor(() => {
      const saves = popupBrowser.runtime.sendMessage.mock.calls
        .map(([request]) => request)
        .filter(({ type }) => type === "tabhub:context-save");
      expect(saves).toHaveLength(2);
      expect(saves[1]?.idempotencyKey).toBe(saves[0]?.idempotencyKey);
    });
  });

  it("localizes history state and promotes with the selected kind", async () => {
    await popupModule.refreshContext();
    const history = document.querySelector("#intent-history")?.textContent;
    expect(history).toContain("popupIntentStateArchived");
    expect(history).not.toContain("archived:");
    const kind = document.querySelector<HTMLSelectElement>("#context-kind")!;
    kind.value = "question";
    document.querySelector<HTMLButtonElement>("#intent-promote")!.click();
    await vi.waitFor(() =>
      expect(popupBrowser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          contextKind: "question",
          expectedPage: expect.objectContaining({
            instanceRevision: 1,
            url: "https://example.com/article",
          }),
          scope: expect.objectContaining({
            browserTabId: 13,
          }),
          type: "tabhub:context-intent-action",
        }),
      ),
    );
  });

  it("archives with the exact scope and expected page rendered for the intent", async () => {
    await popupModule.refreshContext();
    document.querySelector<HTMLButtonElement>("#intent-archive")!.click();
    await vi.waitFor(() =>
      expect(popupBrowser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedPage: expect.objectContaining({
            logicalPageId: 17,
            url: "https://example.com/article",
          }),
          kind: "archive",
          scope: expect.objectContaining({ browserTabId: 13 }),
          type: "tabhub:context-intent-action",
        }),
      ),
    );
  });

  it("hides the context UI when feature discovery turns it off", async () => {
    popupBrowser.contextEnabled = false;
    await popupModule.refreshContext();
    expect(document.querySelector<HTMLElement>("#context-section")!.hidden).toBe(
      true,
    );
  });

  it("requires confirmation before discarding the exact stale head and resuming successors", async () => {
    popupBrowser.staleContextQueue = true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await popupModule.refreshContext();
    const discard = document.querySelector<HTMLButtonElement>(
      "#context-discard-stale",
    )!;

    expect(discard.hidden).toBe(false);
    expect(discard.type).toBe("button");
    expect(discard.getAttribute("aria-describedby")).toBe("context-feedback");
    discard.click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(popupBrowser.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tabhub:context-discard-stale" }),
    );

    confirm.mockReturnValue(true);
    discard.click();
    await vi.waitFor(() =>
      expect(popupBrowser.runtime.sendMessage).toHaveBeenCalledWith({
        queueHeadId: "stale-head-id",
        type: "tabhub:context-discard-stale",
      }),
    );
    await vi.waitFor(() => expect(discard.hidden).toBe(true));
    expect(document.querySelector("#context-feedback")?.textContent).toBe(
      "popupContextStaleDiscarded",
    );
  });

  it("offers no visibility choice and always saves context as AI-visible", async () => {
    await popupModule.refreshContext();
    expect(document.querySelector("#context-visibility")).toBeNull();
    expect(document.querySelector("#context-visibility-label")).toBeNull();

    const form = document.querySelector<HTMLFormElement>("#context-form")!;
    const body = document.querySelector<HTMLTextAreaElement>("#context-body")!;
    body.value = "Notes the AI is always allowed to read";
    form.requestSubmit();

    await vi.waitFor(() =>
      expect(popupBrowser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Notes the AI is always allowed to read",
          type: "tabhub:context-save",
          visibility: "share_with_ai",
        }),
      ),
    );
  });

  it("tells the user in the pairing panel that pairing is a one-time step", async () => {
    await popupModule.refreshContext();
    expect(document.querySelector("#pairing-once")?.textContent).toBe(
      "popupPairingOnce",
    );
  });
});
