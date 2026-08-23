// @vitest-environment jsdom

import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrioritySafeRead } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../src/App";
import { unavailableExtensionBridge } from "./support/extension-bridge-stub";
import { I18nProvider } from "../src/i18n";
import { TabDrawer } from "../src/TabDrawer";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 82,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * 82,
        index,
        key: index,
        size: 82,
        start: index * 82,
      })),
    measureElement: () => undefined,
    scrollToOffset: () => undefined,
  }),
}));

vi.mock("../src/use-canonical-tab-activation", () => ({
  useCanonicalTabActivation: () => ({
    busy: false,
    errorFor: () => undefined,
    errorForPhysical: () => undefined,
    isActivating: () => false,
    isActivatingPhysical: () => false,
    run: vi.fn(),
    runPhysical: vi.fn(),
  }),
}));

vi.mock("../src/use-single-tab-close", () => ({
  useSingleTabClose: () => ({
    busy: false,
    closeCanonical: vi.fn(),
    closePhysical: vi.fn(),
    errorForCanonical: () => undefined,
    errorForPhysical: () => undefined,
    isClosingCanonical: () => false,
    isClosingPhysical: () => false,
  }),
}));
vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => unavailableExtensionBridge(),
}));

interface HttpRequestRecord {
  method: string;
  pathname: string;
  search: string;
}

interface ReadyMessage {
  type: "ready";
  origin: string;
  schemaVersion: number;
  initialDefaultOrder?: string[];
  postRunDefaultOrder?: string[];
  priority?: PrioritySafeRead;
  research?: { id: number; logicalPageId: number };
}

const SAFE_PRIORITY_TRANSCRIPT = [
  { method: "GET", pathname: /^\/api\/features$/ },
  { method: "GET", pathname: /^\/api\/tabs$/ },
  { method: "GET", pathname: /^\/api\/tab-instances\/library-bulk$/ },
  { method: "GET", pathname: /^\/api\/tabs\/\d+$/ },
  { method: "GET", pathname: /^\/api\/tabs\/\d+\/instances$/ },
  { method: "GET", pathname: /^\/api\/tab-command-relay\/scopes$/ },
  { method: "GET", pathname: /^\/api\/links$/ },
  { method: "GET", pathname: /^\/api\/logical-pages\/by-tab\/\d+$/ },
  { method: "GET", pathname: /^\/api\/tags$/ },
  { method: "POST", pathname: /^\/api\/personalization\/priority\/read-batch$/ },
] as const;

const DESTRUCTIVE_PATH = /(?:\/api\/retention\/(?:tabs|trash)\/|\/api\/tab-command-relay\/commands$|\/api\/resources\/commands$|\/context(?:\/|$)|\/api\/local\/session-intents\/commands$|\/priority-feedback$)/;

function assertSafePriorityTranscript(
  records: readonly HttpRequestRecord[],
  options: { priorityReadRequired: boolean },
) {
  const disallowed = records.filter(
    (record) => !SAFE_PRIORITY_TRANSCRIPT.some(
      ({ method, pathname }) =>
        method === record.method && pathname.test(record.pathname),
    ),
  );
  expect(disallowed).toEqual([]);

  const mutations = records.filter(({ method }) =>
    method === "DELETE" || method === "PATCH" || method === "PUT"
  );
  expect(mutations).toEqual([]);

  const destructiveRequests = records.filter(({ pathname }) =>
    DESTRUCTIVE_PATH.test(pathname)
  );
  expect(destructiveRequests).toEqual([]);

  const priorityReads = records.filter(
    ({ method, pathname }) =>
      method === "POST" &&
      pathname === "/api/personalization/priority/read-batch",
  );
  if (options.priorityReadRequired) {
    expect(priorityReads.length).toBeGreaterThan(0);
  } else {
    expect(priorityReads).toEqual([]);
  }
  expect(records.filter(({ method }) => method === "POST")).toEqual(priorityReads);
}

function startServerWorker(
  databasePath: string,
  profile: "on" | "off",
): Promise<{ child: ChildProcess; ready: ReadyMessage }> {
  const workerPath = join(
    process.cwd(),
    "test",
    "support",
    "priority-rest-server-worker.ts",
  );
  const child = fork(workerPath, [], {
    env: {
      ...process.env,
      TABHUB_TEST_DATABASE_PATH: databasePath,
      TABHUB_TEST_PRIORITY_PROFILE: profile,
    },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Priority REST worker timed out. ${stderr}`));
    }, 20_000);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("message", (message: ReadyMessage | {
      type: "error";
      message: string;
      stack?: string;
    }) => {
      if (message.type === "ready") {
        clearTimeout(timeout);
        resolve({ child, ready: message });
      } else if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(`${message.message}\n${message.stack ?? ""}\n${stderr}`));
      }
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Priority REST worker exited ${code}. ${stderr}`));
      }
    });
  });
}

async function stopServerWorker(child: ChildProcess | undefined) {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) return;
  await new Promise<void>((resolve) => {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timeout);
      if (fallback !== undefined) clearTimeout(fallback);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      fallback = setTimeout(finish, 5_000);
    }, 5_000);
    child.once("close", finish);
    child.send("stop", (error) => {
      if (error !== null) child.kill();
    });
  });
}

function installServerFetch(origin: string, records: HttpRequestRecord[]) {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, origin);
    records.push({
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      pathname: url.pathname,
      search: url.search,
    });
    return nativeFetch(url, init);
  });
}

function renderWithClient(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(rendered, { queryClient });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("priority shadow real REST integration", () => {
  it("renders persisted assessment evidence and fails closed after feature-off restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-web-priority-rest-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let onWorker: ChildProcess | undefined;
    let offWorker: ChildProcess | undefined;
    let onView: ReturnType<typeof renderWithClient> | undefined;
    let detailView: ReturnType<typeof renderWithClient> | undefined;
    let offView: ReturnType<typeof renderWithClient> | undefined;

    try {
      const on = await startServerWorker(databasePath, "on");
      onWorker = on.child;
      const {
        initialDefaultOrder,
        postRunDefaultOrder,
        priority,
        research,
      } = on.ready;
      expect(on.ready.schemaVersion).toBe(24);
      expect(initialDefaultOrder).toEqual([
        "Priority REST research",
        "Priority REST reference",
      ]);
      expect(postRunDefaultOrder).toEqual(initialDefaultOrder);
      expect(research).toBeDefined();
      expect(priority).toMatchObject({
        subject: { type: "page", logicalPageId: research?.logicalPageId },
        outcome: {
          kind: "assessment",
          assessment: {
            agentScore: 50,
            agentBand: "medium",
            confidence: 0.5,
            reasons: [
              {
                code: "rule:baseline.pinned",
                label: "Pinned in the browser",
                scoreDelta: 10,
              },
              {
                code: "review:low-confidence",
                label: "Confidence is below the active review threshold",
              },
            ],
            missingSignals: ["active_use_30d_ms", "captured_content"],
          },
        },
        isCurrent: true,
        dirty: false,
        needsReview: true,
      });
      if (research === undefined || initialDefaultOrder === undefined) {
        throw new Error("Priority REST worker returned incomplete setup data");
      }

      const onRequests: HttpRequestRecord[] = [];
      installServerFetch(on.ready.origin, onRequests);
      window.history.replaceState({}, "", "/app/");

      onView = renderWithClient(<App />);
      await waitFor(() => {
        expect(
          screen.getAllByRole("button")
            .filter((node) => node.classList.contains("tab-open-button"))
            .map(({ textContent }) => textContent),
        ).toEqual(initialDefaultOrder);
      });
      expect(await screen.findByText("AI: 50")).toBeTruthy();
      expect(screen.getByText("You: 3")).toBeTruthy();
      expect(onRequests.some(({ pathname }) =>
        pathname === "/api/personalization/priority/read-batch")).toBe(true);
      expect(onRequests.some(({ search }) => search.includes("sort_by="))).toBe(false);
      const appRequestCount = onRequests.length;

      onView.unmount();
      onView.queryClient.clear();
      onView = undefined;
      detailView = renderWithClient(
        <TabDrawer tabId={research.id} onBrowserAction={vi.fn()} onClose={vi.fn()} />,
      );
      expect(await screen.findByRole("heading", { name: "AI priority" })).toBeTruthy();
      expect(await screen.findByText("AI: 50")).toBeTruthy();
      expect(screen.getByText("You: 3")).toBeTruthy();
      expect(screen.getByText("Medium")).toBeTruthy();
      expect(screen.getByText("50%")).toBeTruthy();
      expect(screen.getByText("Pinned in the browser")).toBeTruthy();
      expect(screen.getByText("+10 score")).toBeTruthy();
      expect(screen.getByText(
        "Confidence is below the active review threshold",
      )).toBeTruthy();
      expect(screen.getByText("30-day active use")).toBeTruthy();
      expect(screen.getAllByText("Captured content").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();
      expect(onRequests.length).toBeGreaterThan(appRequestCount);
      expect(onRequests.some(
        ({ method, pathname }) =>
          method === "GET" && pathname === `/api/tabs/${research.id}`,
      )).toBe(true);
      expect(onRequests.some(
        ({ method, pathname }) =>
          method === "GET" &&
          pathname === `/api/logical-pages/by-tab/${research.id}`,
      )).toBe(true);
      assertSafePriorityTranscript(onRequests, { priorityReadRequired: true });

      detailView.unmount();
      detailView.queryClient.clear();
      detailView = undefined;
      vi.unstubAllGlobals();
      await stopServerWorker(onWorker);
      onWorker = undefined;

      const off = await startServerWorker(databasePath, "off");
      offWorker = off.child;
      expect(off.ready.schemaVersion).toBe(24);
      const offRequests: HttpRequestRecord[] = [];
      installServerFetch(off.ready.origin, offRequests);

      offView = renderWithClient(<App />);
      expect(await screen.findByText("Priority REST research")).toBeTruthy();
      expect(await screen.findByLabelText("Importance 3 of 3")).toBeTruthy();
      await waitFor(() => expect(offRequests.some(
        ({ pathname }) => pathname === "/api/features",
      )).toBe(true));
      expect(offRequests.some(({ pathname }) =>
        pathname.startsWith("/api/personalization/priority"))).toBe(false);
      expect(screen.queryByText("AI: 50")).toBeNull();
      expect(screen.queryByText("You: 3")).toBeNull();
      expect(screen.queryByRole("button", { name: "Review AI priorities" })).toBeNull();
      assertSafePriorityTranscript(offRequests, { priorityReadRequired: false });
    } finally {
      onView?.unmount();
      onView?.queryClient.clear();
      detailView?.unmount();
      detailView?.queryClient.clear();
      offView?.unmount();
      offView?.queryClient.clear();
      vi.unstubAllGlobals();
      await stopServerWorker(offWorker);
      await stopServerWorker(onWorker);
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }, 30_000);
});
