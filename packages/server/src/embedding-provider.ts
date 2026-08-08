export type EmbeddingInputType = "query" | "document";

export interface EmbeddingProvider {
  provider: string;
  model: string;
  dimensions: 512;
  embed(
    input: string[],
    inputType: EmbeddingInputType,
    signal?: AbortSignal,
  ): Promise<number[][]>;
}

export type EmbeddingProviderErrorKind =
  | "unavailable"
  | "upstream"
  | "invalid_response";

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly kind: EmbeddingProviderErrorKind,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EmbeddingProviderError";
  }
}

export interface OllamaEmbeddingProviderOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VoyageEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface EmbeddingProviderFactoryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type EmbeddingProviderEnvironment = Record<string, string | undefined>;

const EMBEDDING_DIMENSIONS = 512 as const;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_TIMEOUT_MS = 120_000;
const VOYAGE_FIXED_512_MODELS = new Set(["voyage-3-lite"]);
const VOYAGE_FLEXIBLE_DIMENSION_MODELS = new Set([
  "voyage-4-large",
  "voyage-4",
  "voyage-4-lite",
  "voyage-3-large",
  "voyage-3.5",
  "voyage-3.5-lite",
  "voyage-code-3",
]);

function validatedTimeout(value: number, name = "timeoutMs"): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new EmbeddingProviderError(
      `${name} must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
      "unavailable",
      false,
    );
  }
  return value;
}

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function upstreamDetail(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("error" in value) {
    if (typeof value.error === "string") {
      return value.error;
    }
    if (
      typeof value.error === "object" &&
      value.error !== null &&
      "message" in value.error &&
      typeof value.error.message === "string"
    ) {
      return value.error.message;
    }
  }
  return "message" in value && typeof value.message === "string"
    ? value.message
    : undefined;
}

async function requestJson(
  provider: string,
  fetchImpl: typeof fetch,
  endpoint: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    callerSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([callerSignal, timeoutSignal]);
  let response: Response;

  try {
    response = await fetchImpl(endpoint, { ...init, signal });
  } catch (error) {
    throw unavailableRequestError(
      provider,
      callerSignal,
      timeoutSignal,
      timeoutMs,
      error,
    );
  }

  let body: unknown;
  try {
    body = await waitForSignal(response.json(), signal);
  } catch (error) {
    if (callerSignal?.aborted === true || timeoutSignal.aborted) {
      throw unavailableRequestError(
        provider,
        callerSignal,
        timeoutSignal,
        timeoutMs,
        error,
      );
    }
    if (!response.ok) {
      throw new EmbeddingProviderError(
        `${provider} returned HTTP ${response.status} with a non-JSON response`,
        "upstream",
        isRetryableStatus(response.status),
        response.status,
        { cause: error },
      );
    }
    throw new EmbeddingProviderError(
      `${provider} returned a non-JSON embedding response`,
      "invalid_response",
      false,
      response.status,
      { cause: error },
    );
  }

  if (!response.ok) {
    const detail = upstreamDetail(body);
    throw new EmbeddingProviderError(
      `${provider} returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      "upstream",
      isRetryableStatus(response.status),
      response.status,
    );
  }
  return body;
}

function unavailableRequestError(
  provider: string,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  cause: unknown,
): EmbeddingProviderError {
  const callerAborted = callerSignal?.aborted === true;
  const timedOut = timeoutSignal.aborted && !callerAborted;
  return new EmbeddingProviderError(
    callerAborted
      ? `${provider} embedding request was cancelled`
      : timedOut
        ? `${provider} embedding request timed out after ${timeoutMs}ms`
        : `${provider} embedding provider is unavailable`,
    "unavailable",
    !callerAborted,
    undefined,
    { cause },
  );
}

async function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((coordinate) =>
      typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  );
}

function ollamaVectors(value: unknown, count: number): number[][] {
  if (typeof value !== "object" || value === null || !("embeddings" in value)) {
    throw new EmbeddingProviderError(
      "Ollama returned an invalid embed response",
      "invalid_response",
      false,
    );
  }

  const vectors = value.embeddings;
  if (
    !Array.isArray(vectors) ||
    vectors.length !== count ||
    !vectors.every(validVector)
  ) {
    throw new EmbeddingProviderError(
      `Ollama returned embeddings that are not ${EMBEDDING_DIMENSIONS}-dimensional`,
      "invalid_response",
      false,
    );
  }
  return vectors;
}

function voyageVectors(value: unknown, count: number): number[][] {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new EmbeddingProviderError(
      "Voyage returned an invalid embeddings response",
      "invalid_response",
      false,
    );
  }

  const data = value.data;
  if (!Array.isArray(data) || data.length !== count) {
    throw new EmbeddingProviderError(
      "Voyage returned the wrong number of embeddings",
      "invalid_response",
      false,
    );
  }

  const vectors: Array<number[] | undefined> = Array.from({ length: count });
  for (const item of data) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("index" in item) ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      !("embedding" in item) ||
      !validVector(item.embedding) ||
      vectors[item.index] !== undefined
    ) {
      throw new EmbeddingProviderError(
        `Voyage returned embeddings that are not ${EMBEDDING_DIMENSIONS}-dimensional and uniquely indexed`,
        "invalid_response",
        false,
      );
    }
    vectors[item.index] = item.embedding;
  }

  if (vectors.some((vector) => vector === undefined)) {
    throw new EmbeddingProviderError(
      "Voyage returned a response with missing embeddings",
      "invalid_response",
      false,
    );
  }
  return vectors as number[][];
}

export function createOllamaEmbeddingProvider(
  options: OllamaEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const baseUrl = normalizedBaseUrl(
    options.baseUrl ?? "http://127.0.0.1:11434",
  );
  const model = options.model ?? "nomic-embed-text";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = validatedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    provider: "ollama",
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(input, _inputType, signal) {
      if (input.length === 0) {
        return [];
      }

      const body = await requestJson(
        "Ollama",
        fetchImpl,
        `${baseUrl}/api/embed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input,
            dimensions: EMBEDDING_DIMENSIONS,
            truncate: true,
          }),
        },
        signal,
        timeoutMs,
      );
      return ollamaVectors(body, input.length);
    },
  };
}

export function createVoyageEmbeddingProvider(
  options: VoyageEmbeddingProviderOptions,
): EmbeddingProvider {
  const model = options.model ?? "voyage-3-lite";
  const supportsFlexibleDimensions = VOYAGE_FLEXIBLE_DIMENSION_MODELS.has(model);
  if (!supportsFlexibleDimensions && !VOYAGE_FIXED_512_MODELS.has(model)) {
    throw new EmbeddingProviderError(
      `Voyage model ${model} cannot be guaranteed to return 512 dimensions`,
      "unavailable",
      false,
    );
  }
  const endpoint =
    options.endpoint ?? "https://api.voyageai.com/v1/embeddings";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = validatedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    provider: "voyage",
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(input, inputType, signal) {
      if (input.length === 0) {
        return [];
      }

      const body = await requestJson(
        "Voyage",
        fetchImpl,
        endpoint,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input,
            model,
            input_type: inputType,
            truncation: true,
            ...(supportsFlexibleDimensions
              ? { output_dimension: EMBEDDING_DIMENSIONS }
              : {}),
          }),
        },
        signal,
        timeoutMs,
      );
      return voyageVectors(body, input.length);
    },
  };
}

function configuredValue(
  environment: EmbeddingProviderEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function configuredTimeout(
  environment: EmbeddingProviderEnvironment,
  fallback: number | undefined,
): number | undefined {
  const raw = configuredValue(environment, "TABHUB_EMBEDDING_TIMEOUT_MS");
  if (raw === undefined) {
    return fallback;
  }

  return validatedTimeout(Number(raw), "TABHUB_EMBEDDING_TIMEOUT_MS");
}

export function createEmbeddingProviderFromEnv(
  environment: EmbeddingProviderEnvironment = process.env,
  options: EmbeddingProviderFactoryOptions = {},
): EmbeddingProvider | undefined {
  const selection = (
    configuredValue(environment, "EMBEDDING_PROVIDER") ?? "ollama"
  ).toLowerCase();
  const timeoutMs = configuredTimeout(environment, options.timeoutMs);
  const common = {
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  if (selection === "disabled") {
    return undefined;
  }
  if (selection === "ollama") {
    return createOllamaEmbeddingProvider({
      ...common,
      baseUrl:
        configuredValue(environment, "OLLAMA_BASE_URL") ??
        "http://127.0.0.1:11434",
      model:
        configuredValue(environment, "OLLAMA_EMBEDDING_MODEL") ??
        "nomic-embed-text",
    });
  }
  if (selection === "voyage") {
    const apiKey = configuredValue(environment, "VOYAGE_API_KEY");
    if (apiKey === undefined) {
      throw new EmbeddingProviderError(
        "VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage",
        "unavailable",
        false,
      );
    }
    return createVoyageEmbeddingProvider({
      ...common,
      apiKey,
      model:
        configuredValue(environment, "VOYAGE_EMBEDDING_MODEL") ??
        "voyage-3-lite",
    });
  }

  throw new EmbeddingProviderError(
    `Unsupported EMBEDDING_PROVIDER: ${selection}`,
    "unavailable",
    false,
  );
}
