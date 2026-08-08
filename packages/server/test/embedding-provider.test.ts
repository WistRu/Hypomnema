import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddingProviderFromEnv,
  createOllamaEmbeddingProvider,
  createVoyageEmbeddingProvider,
  EmbeddingProviderError,
} from "../src/embedding-provider.js";

const vector = (value: number): number[] => Array<number>(512).fill(value);

describe("Ollama embedding provider", () => {
  it("posts document inputs to Ollama's embed endpoint and returns 512-dimensional vectors", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "nomic-embed-text",
          embeddings: [vector(0.25), vector(0.5)],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = createOllamaEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434///",
      model: "nomic-embed-text",
      fetchImpl,
    });

    await expect(
      provider.embed(["first page", "second page"], "document"),
    ).resolves.toEqual([vector(0.25), vector(0.5)]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/api/embed");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "nomic-embed-text",
      input: ["first page", "second page"],
      dimensions: 512,
      truncate: true,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports upstream HTTP failures with retryability and status", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "model is loading" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = createOllamaEmbeddingProvider({ fetchImpl });

    await expect(
      provider.embed(["page"], "document"),
    ).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      kind: "upstream",
      retryable: true,
      status: 503,
      message: expect.stringContaining("model is loading"),
    });
  });

  it("rejects the wrong dimensions and non-finite coordinates", async () => {
    for (const embedding of [
      Array<number>(511).fill(0.25),
      [...Array<number>(511).fill(0.25), Number.NaN],
    ]) {
      const fetchImpl: typeof fetch = vi.fn(async () =>
        new Response(JSON.stringify({ embeddings: [embedding] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const provider = createOllamaEmbeddingProvider({ fetchImpl });

      await expect(
        provider.embed(["page"], "document"),
      ).rejects.toMatchObject({
        kind: "invalid_response",
        retryable: false,
      });
    }
  });

  it("propagates caller cancellation through a typed unavailable error", async () => {
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const provider = createOllamaEmbeddingProvider({
      fetchImpl,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = provider.embed(["page"], "document", controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      kind: "unavailable",
      retryable: false,
      message: expect.stringContaining("cancelled"),
    });
  });

  it("reports timeouts and network failures as retryable unavailability", async () => {
    const hangingFetch: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const timedProvider = createOllamaEmbeddingProvider({
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    });
    await expect(
      timedProvider.embed(["page"], "document"),
    ).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
      message: expect.stringContaining("timed out"),
    });

    const offlineProvider = createOllamaEmbeddingProvider({
      fetchImpl: vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    });
    await expect(
      offlineProvider.embed(["page"], "document"),
    ).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
      message: "Ollama embedding provider is unavailable",
    });
  });

  it("classifies cancellation and timeout while the response body is stalled", async () => {
    const stalledResponse = (): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => new Promise<never>(() => undefined),
      }) as unknown as Response;
    const fetchImpl: typeof fetch = vi.fn(async () => stalledResponse());

    const cancellable = createOllamaEmbeddingProvider({
      fetchImpl,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const cancelled = cancellable.embed(
      ["page"],
      "document",
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(new Error("stop requested"));
    await expect(cancelled).rejects.toMatchObject({
      kind: "unavailable",
      retryable: false,
      message: expect.stringContaining("cancelled"),
    });

    const timed = createOllamaEmbeddingProvider({
      fetchImpl,
      timeoutMs: 5,
    });
    await expect(timed.embed(["page"], "document")).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
      message: expect.stringContaining("timed out"),
    });
  });
});

describe("Voyage embedding provider", () => {
  it("uses Voyage's indexed response and query input type", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { object: "embedding", embedding: vector(0.5), index: 1 },
            { object: "embedding", embedding: vector(0.25), index: 0 },
          ],
          model: "voyage-3-lite",
          usage: { total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = createVoyageEmbeddingProvider({
      apiKey: "voyage-secret",
      model: "voyage-3-lite",
      fetchImpl,
    });

    await expect(
      provider.embed(["first search", "second search"], "query"),
    ).resolves.toEqual([vector(0.25), vector(0.5)]);

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer voyage-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      input: ["first search", "second search"],
      model: "voyage-3-lite",
      input_type: "query",
      truncation: true,
    });
  });

  it("rejects duplicate indexes and non-finite vectors", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: vector(0.25), index: 0 },
            {
              embedding: [...Array<number>(511).fill(0.5), Infinity],
              index: 0,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = createVoyageEmbeddingProvider({
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      provider.embed(["first", "second"], "document"),
    ).rejects.toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("requests 512 dimensions for flexible models and rejects incompatible models", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: vector(0.25), index: 0 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = createVoyageEmbeddingProvider({
      apiKey: "secret",
      model: "voyage-4-lite",
      fetchImpl,
    });

    await provider.embed(["page"], "document");
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "voyage-4-lite",
      output_dimension: 512,
    });

    expect(() =>
      createVoyageEmbeddingProvider({
        apiKey: "secret",
        model: "voyage-3",
      }),
    ).toThrow(
      expect.objectContaining({
        kind: "unavailable",
        message: expect.stringContaining("512 dimensions"),
      }),
    );
  });

  it("never exposes API keys or raw transport errors in public messages", async () => {
    const apiKey = "voyage-super-secret";
    const rawMessage = `request failed with Authorization: Bearer ${apiKey}`;
    const provider = createVoyageEmbeddingProvider({
      apiKey,
      fetchImpl: vi.fn(async () => {
        throw new TypeError(rawMessage);
      }),
    });

    try {
      await provider.embed(["page"], "document");
      throw new Error("Expected provider to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as Error).message).not.toContain(apiKey);
      expect((error as Error).message).not.toContain(rawMessage);
      expect((error as Error).cause).toMatchObject({ message: rawMessage });
    }
  });
});

describe("embedding provider selection", () => {
  it("selects and configures the requested provider without making a request", () => {
    const fetchImpl: typeof fetch = vi.fn();

    const local = createEmbeddingProviderFromEnv(
      {
        EMBEDDING_PROVIDER: "ollama",
        OLLAMA_BASE_URL: "http://localhost:22000/",
        OLLAMA_EMBEDDING_MODEL: "local-model",
      },
      { fetchImpl },
    );
    expect(local).toMatchObject({
      provider: "ollama",
      model: "local-model",
      dimensions: 512,
    });

    const hosted = createEmbeddingProviderFromEnv(
      {
        EMBEDDING_PROVIDER: "voyage",
        VOYAGE_API_KEY: "secret",
        VOYAGE_EMBEDDING_MODEL: "voyage-3-lite",
      },
      { fetchImpl },
    );
    expect(hosted).toMatchObject({
      provider: "voyage",
      model: "voyage-3-lite",
      dimensions: 512,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("supports explicit disablement and reports invalid configuration as unavailable", () => {
    expect(createEmbeddingProviderFromEnv({})).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 512,
    });
    expect(
      createEmbeddingProviderFromEnv({ EMBEDDING_PROVIDER: "disabled" }),
    ).toBeUndefined();
    expect(() =>
      createEmbeddingProviderFromEnv({ EMBEDDING_PROVIDER: "voyage" }),
    ).toThrow(
      expect.objectContaining({
        name: "EmbeddingProviderError",
        kind: "unavailable",
        retryable: false,
      }),
    );
    expect(() =>
      createEmbeddingProviderFromEnv({ EMBEDDING_PROVIDER: "mystery" }),
    ).toThrow(EmbeddingProviderError);
    expect(() =>
      createEmbeddingProviderFromEnv({
        TABHUB_EMBEDDING_TIMEOUT_MS: "0",
      }),
    ).toThrow(/integer between 1 and 2147483647/);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    "rejects invalid public timeout %s before making a request",
    (timeoutMs) => {
      expect(() =>
        createOllamaEmbeddingProvider({ timeoutMs }),
      ).toThrow(
        expect.objectContaining({
          kind: "unavailable",
          retryable: false,
        }),
      );
      expect(() =>
        createVoyageEmbeddingProvider({ apiKey: "secret", timeoutMs }),
      ).toThrow(EmbeddingProviderError);
    },
  );

  it.each(["-1", "1.5", "NaN", "2147483648"])(
    "rejects invalid environment timeout %s",
    (timeoutMs) => {
      expect(() =>
        createEmbeddingProviderFromEnv({
          TABHUB_EMBEDDING_TIMEOUT_MS: timeoutMs,
        }),
      ).toThrow(/between 1 and 2147483647/);
    },
  );
});
