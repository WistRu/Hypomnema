import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp, type TabHubApp } from "../src/app.js";
import { EmbeddingProviderError } from "../src/embedding-provider.js";

const temporaryDirectories: string[] = [];
const apps: TabHubApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function embeddingFor(text: string): number[] {
  const vector = Array.from({ length: 512 }, () => 0);
  const normalized = text.toLocaleLowerCase();

  if (/rust|compiler|borrow|systems/.test(normalized)) {
    vector[0] = 1;
  }
  if (/bread|recipe|sourdough/.test(normalized)) {
    vector[1] = 1;
  }
  if (vector[0] === 0 && vector[1] === 0) {
    vector[2] = 1;
  }

  return vector;
}

async function createTestApp() {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-semantic-"));
  temporaryDirectories.push(directory);
  const calls: Array<{ input: string[]; inputType: string }> = [];
  const app = createApp({
    databasePath: join(directory, "tabhub.sqlite"),
    logger: false,
    embeddingProvider: {
      provider: "fake",
      model: "fake-512",
      dimensions: 512,
      async embed(input, inputType) {
        calls.push({ input: [...input], inputType });
        return input.map(embeddingFor);
      },
    },
  });
  apps.push(app);
  return { app, calls };
}

async function seedTabs(app: TabHubApp) {
  const tabs = [
    {
      url: "https://example.com/rust",
      title: "Rust borrow checker",
      text: "A practical guide to the Rust compiler and borrow checking.",
    },
    {
      url: "https://example.com/bread",
      title: "Sourdough recipe",
      text: "A bread recipe with a sourdough starter.",
    },
  ];
  await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      tabs: tabs.map((tab, index) => ({
        url: tab.url,
        title: tab.title,
        windowId: 1,
        index,
      })),
    },
  });
  for (const tab of tabs) {
    await app.inject({
      method: "POST",
      url: "/api/ingest/content",
      payload: {
        browser: "chrome",
        url: tab.url,
        text: tab.text,
        htmlExcerpt: `<article>${tab.text}</article>`,
      },
    });
  }
  const listed = await app.inject({ method: "GET", url: "/api/tabs" });
  return Object.fromEntries(
    listed
      .json()
      .items.map((tab: { id: number; title: string }) => [tab.title, tab.id]),
  ) as Record<string, number>;
}

describe("semantic tab search", () => {
  it("loads sqlite-vec, explicitly indexes captured content, and ranks a query", async () => {
    const { app, calls } = await createTestApp();
    const ids = await seedTabs(app);

    expect(calls).toEqual([]);
    const reindex = await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });

    expect(reindex.statusCode).toBe(200);
    expect(reindex.json()).toEqual({
      indexed: 2,
      skipped: 0,
      remaining: 0,
      provider: "fake",
      model: "fake-512",
      dimensions: 512,
    });
    expect(calls).toEqual([
      {
        input: [
          "A practical guide to the Rust compiler and borrow checking.",
          "A bread recipe with a sourdough starter.",
        ],
        inputType: "document",
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/tabs?q=compiler&search_mode=semantic",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((tab: { id: number }) => tab.id)).toEqual([
      ids["Rust borrow checker"],
      ids["Sourdough recipe"],
    ]);
    expect(calls.at(-1)).toEqual({ input: ["compiler"], inputType: "query" });
  });

  it("invalidates a vector on content revision and supports similar_to after reindex", async () => {
    const { app } = await createTestApp();
    const ids = await seedTabs(app);
    await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });

    await app.inject({
      method: "POST",
      url: "/api/ingest/content",
      payload: {
        browser: "chrome",
        url: "https://example.com/rust",
        text: "A revised sourdough bread recipe.",
        htmlExcerpt: "<article>A revised sourdough bread recipe.</article>",
      },
    });

    const stale = await app.inject({
      method: "GET",
      url: `/api/tabs?similar_to=${ids["Rust borrow checker"]}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "EMBEDDING_NOT_INDEXED" });

    const reindex = await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });
    expect(reindex.json()).toMatchObject({ indexed: 1, remaining: 0 });

    const similar = await app.inject({
      method: "GET",
      url: `/api/tabs?similar_to=${ids["Rust borrow checker"]}`,
    });
    expect(similar.statusCode).toBe(200);
    expect(similar.json().items.map((tab: { id: number }) => tab.id)).toEqual([
      ids["Sourdough recipe"],
    ]);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().schemaVersion).toBe(5);
  });

  it("maps embedding provider failures without hiding their retry metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-semantic-error-"));
    temporaryDirectories.push(directory);
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      embeddingProvider: {
        provider: "fake",
        model: "fake-512",
        dimensions: 512,
        async embed() {
          throw new EmbeddingProviderError(
            "Fake embedding upstream rejected the request",
            "upstream",
            true,
            429,
          );
        },
      },
    });
    apps.push(app);
    await seedTabs(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "EMBEDDING_PROVIDER_ERROR",
      message: "Fake embedding upstream rejected the request",
      retryable: true,
      upstreamStatus: 429,
    });
  });

  it("explicitly indexes and deterministically clusters inbox content with meaningful names", async () => {
    const { app, calls } = await createTestApp();
    const tabs = [
      {
        url: "https://example.com/rust-ownership",
        title: "Rust ownership guide",
        text: "Rust compiler ownership and borrow checker patterns.",
      },
      {
        url: "https://example.com/rust-async",
        title: "Rust async systems",
        text: "Systems programming with the Rust compiler and async tasks.",
      },
      {
        url: "https://example.com/bread-starter",
        title: "Sourdough starter recipe",
        text: "Bread fermentation and sourdough starter recipe notes.",
      },
      {
        url: "https://example.com/bread-baking",
        title: "Sourdough bread baking",
        text: "A sourdough bread recipe for home baking.",
      },
      {
        url: "https://example.com/not-captured",
        title: "Uncaptured inbox tab",
      },
    ];
    await app.inject({
      method: "POST",
      url: "/api/ingest/snapshot",
      payload: {
        browser: "edge",
        tabs: tabs.map((tab, index) => ({
          url: tab.url,
          title: tab.title,
          windowId: 1,
          index,
        })),
      },
    });
    for (const tab of tabs) {
      if (tab.text === undefined) continue;
      await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "edge",
          url: tab.url,
          text: tab.text,
          htmlExcerpt: `<article>${tab.text}</article>`,
        },
      });
    }
    const list = await app.inject({
      method: "GET",
      url: "/api/tabs?pageSize=20",
    });
    const titleById = new Map<number, string>(
      list
        .json()
        .items.map((tab: { id: number; title: string }) => [tab.id, tab.title]),
    );

    const first = await app.inject({
      method: "POST",
      url: "/api/clusters/inbox",
      payload: { maxClusters: 2 },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ indexed: 4, unclustered: 1 });
    expect(first.json().clusters).toHaveLength(2);
    const clusteredTitles = first
      .json()
      .clusters.map((cluster: { tabIds: number[] }) =>
        cluster.tabIds.map((id) => titleById.get(id)).sort(),
      )
      .sort((left: string[], right: string[]) => left[0]!.localeCompare(right[0]!));
    expect(clusteredTitles).toEqual([
      ["Rust async systems", "Rust ownership guide"],
      ["Sourdough bread baking", "Sourdough starter recipe"],
    ]);
    expect(
      first.json().clusters.some((cluster: { name: string }) =>
        /rust/i.test(cluster.name),
      ),
    ).toBe(true);
    expect(
      first.json().clusters.some((cluster: { name: string }) =>
        /bread|sourdough/i.test(cluster.name),
      ),
    ).toBe(true);
    expect(
      first.json().clusters.every(
        (cluster: { keywords: string[]; size: number; tabIds: number[] }) =>
          cluster.keywords.length > 0 && cluster.size === cluster.tabIds.length,
      ),
    ).toBe(true);
    expect(calls.every(({ inputType }) => inputType === "document")).toBe(true);

    const second = await app.inject({
      method: "POST",
      url: "/api/clusters/inbox",
      payload: { maxClusters: 2 },
    });
    expect(second.json()).toEqual({
      ...first.json(),
      indexed: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it("bounds document input before calling an embedding provider", async () => {
    const { app, calls } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/ingest/snapshot",
      payload: {
        browser: "chrome",
        tabs: [
          {
            url: "https://example.com/large",
            title: "Large captured page",
            windowId: 1,
            index: 0,
          },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/ingest/content",
      payload: {
        browser: "chrome",
        url: "https://example.com/large",
        text: `rust ${"x".repeat(39_995)}`,
        htmlExcerpt: "<article>large</article>",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(calls[0]!.input[0]).toHaveLength(32_000);
  });

  it("preserves old vectors on provider failure and replaces them per successful tab", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-provider-switch-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    const firstApp = createApp({
      databasePath,
      logger: false,
      embeddingProvider: {
        provider: "first-provider",
        model: "first-model",
        dimensions: 512,
        async embed(input) {
          return input.map(embeddingFor);
        },
      },
    });
    apps.push(firstApp);
    const ids = await seedTabs(firstApp);
    await firstApp.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });
    apps.splice(apps.indexOf(firstApp), 1);
    await firstApp.close();

    const failingApp = createApp({
      databasePath,
      logger: false,
      embeddingProvider: {
        provider: "second-provider",
        model: "second-model",
        dimensions: 512,
        async embed() {
          throw new EmbeddingProviderError(
            "Second provider is temporarily unavailable",
            "upstream",
            true,
            503,
          );
        },
      },
    });
    apps.push(failingApp);
    const failedReindex = await failingApp.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 1 },
    });
    expect(failedReindex.statusCode).toBe(502);
    const preserved = await failingApp.inject({
      method: "GET",
      url: `/api/tabs?similar_to=${ids["Sourdough recipe"]}`,
    });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().items.map((tab: { id: number }) => tab.id)).toEqual([
      ids["Rust borrow checker"],
    ]);
    apps.splice(apps.indexOf(failingApp), 1);
    await failingApp.close();

    const secondApp = createApp({
      databasePath,
      logger: false,
      embeddingProvider: {
        provider: "second-provider",
        model: "second-model",
        dimensions: 512,
        async embed(input) {
          return input.map(embeddingFor);
        },
      },
    });
    apps.push(secondApp);
    const reindex = await secondApp.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 1 },
    });
    expect(reindex.json()).toMatchObject({ indexed: 1, remaining: 1 });

    const oldVector = await secondApp.inject({
      method: "GET",
      url: `/api/tabs?similar_to=${ids["Sourdough recipe"]}`,
    });
    expect(oldVector.statusCode).toBe(200);
    expect(oldVector.json()).toMatchObject({ total: 0, items: [] });

    const semantic = await secondApp.inject({
      method: "GET",
      url: "/api/tabs?q=compiler&search_mode=semantic",
    });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json().items.map((tab: { id: number }) => tab.id)).toEqual([
      ids["Rust borrow checker"],
    ]);
  });

  it("keeps ordinary reads local and reports when explicit embedding work lacks a provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-no-provider-"));
    temporaryDirectories.push(directory);
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    apps.push(app);
    const ids = await seedTabs(app);

    const fulltext = await app.inject({
      method: "GET",
      url: "/api/tabs?q=compiler",
    });
    expect(fulltext.statusCode).toBe(200);
    expect(fulltext.json().total).toBe(1);

    for (const request of [
      { method: "GET", url: "/api/tabs?q=compiler&search_mode=semantic" },
      {
        method: "POST",
        url: "/api/embeddings/reindex",
        payload: {},
      },
      { method: "POST", url: "/api/clusters/inbox", payload: {} },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "EMBEDDING_PROVIDER_UNAVAILABLE",
      });
    }

    const missingQuery = await app.inject({
      method: "GET",
      url: "/api/tabs?search_mode=semantic",
    });
    expect(missingQuery.statusCode).toBe(400);
    const conflictingQuery = await app.inject({
      method: "GET",
      url: `/api/tabs?q=compiler&similar_to=${ids["Rust borrow checker"]}`,
    });
    expect(conflictingQuery.statusCode).toBe(400);
  });

  it("applies tab filters before the bounded semantic ranking window", async () => {
    const { app } = await createTestApp();
    const ids = await seedTabs(app);
    await app.inject({
      method: "POST",
      url: "/api/embeddings/reindex",
      payload: { limit: 10 },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/tabs/${ids["Rust borrow checker"]}`,
      payload: { status: "done" },
    });

    const filtered = await app.inject({
      method: "GET",
      url: "/api/tabs?q=compiler&search_mode=semantic&status=inbox",
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map((tab: { id: number }) => tab.id)).toEqual([
      ids["Sourdough recipe"],
    ]);

    const beyondWindow = await app.inject({
      method: "GET",
      url: "/api/tabs?q=compiler&search_mode=semantic&page=6&pageSize=200",
    });
    expect(beyondWindow.statusCode).toBe(200);
    expect(beyondWindow.json()).toMatchObject({ total: 2, items: [] });
  });

  it("clusters safely when a valid vector cancels in the signed projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-projection-"));
    temporaryDirectories.push(directory);
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      embeddingProvider: {
        provider: "cancelling-fake",
        model: "cancelling-512",
        dimensions: 512,
        async embed(input) {
          return input.map(() => {
            const vector = Array.from({ length: 512 }, () => 0);
            vector[0] = 1;
            vector[32] = -1;
            return vector;
          });
        },
      },
    });
    apps.push(app);
    await seedTabs(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/clusters/inbox",
      payload: { maxClusters: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      indexed: 2,
      unclustered: 0,
      clusters: [{ size: 2 }],
    });
  });

  it(
    "reports true totals and pages beyond the first 1000 semantic results",
    async () => {
      const { app } = await createTestApp();
      const tabCount = 1_001;
      const tabs = Array.from({ length: tabCount }, (_, index) => ({
        url: `https://example.com/semantic-page-${index}`,
        title: `Semantic page ${index}`,
        windowId: 1,
        index,
      }));
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: { browser: "yandex", tabs },
      });
      let lastTabId = 0;
      for (const tab of tabs) {
        const captured = await app.inject({
          method: "POST",
          url: "/api/ingest/content",
          payload: {
            browser: "yandex",
            url: tab.url,
            text: "Rust compiler semantic pagination content.",
            htmlExcerpt: "<article>Rust compiler content.</article>",
          },
        });
        lastTabId = captured.json().tabId as number;
      }
      const firstBatch = await app.inject({
        method: "POST",
        url: "/api/embeddings/reindex",
        payload: { limit: 1_000 },
      });
      expect(firstBatch.json()).toMatchObject({ indexed: 1_000, remaining: 1 });
      await app.inject({
        method: "POST",
        url: "/api/embeddings/reindex",
        payload: { limit: 10 },
      });

      const page = await app.inject({
        method: "GET",
        url: "/api/tabs?q=compiler&search_mode=semantic&page=6&pageSize=200",
      });

      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({ total: tabCount, page: 6, pageSize: 200 });
      expect(page.json().items.map((tab: { id: number }) => tab.id)).toEqual([
        lastTabId,
      ]);
    },
    20_000,
  );
});
