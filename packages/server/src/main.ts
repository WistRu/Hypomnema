import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";

import { createApp } from "./app.js";
import { createAnthropicSummaryProvider } from "./summary-provider.js";
import { createEmbeddingProviderFromEnv } from "./embedding-provider.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(workspaceRoot, ".env") });

const host = process.env.TABHUB_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.TABHUB_PORT ?? "7717", 10);
const databasePath = resolve(
  workspaceRoot,
  process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
);
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = positiveNumber(name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const sonnetStandardPricingStartsAt = Date.parse("2026-09-01T00:00:00.000Z");
const summaryProvider =
  anthropicApiKey === undefined || anthropicApiKey === ""
    ? undefined
    : createAnthropicSummaryProvider({
        apiKey: anthropicApiKey,
        shortModel:
          process.env.ANTHROPIC_SHORT_MODEL ??
          "claude-haiku-4-5-20251001",
        deepModel: process.env.ANTHROPIC_DEEP_MODEL ?? "claude-sonnet-5",
        shortPricing: () => ({
          inputUsdPerMillionTokens: positiveNumber(
            "ANTHROPIC_SHORT_INPUT_USD_PER_MTOK",
            1,
          ),
          outputUsdPerMillionTokens: positiveNumber(
            "ANTHROPIC_SHORT_OUTPUT_USD_PER_MTOK",
            5,
          ),
        }),
        deepPricing: () => {
          const introductory = Date.now() < sonnetStandardPricingStartsAt;
          return {
            inputUsdPerMillionTokens: positiveNumber(
              "ANTHROPIC_DEEP_INPUT_USD_PER_MTOK",
              introductory ? 2 : 3,
            ),
            outputUsdPerMillionTokens: positiveNumber(
              "ANTHROPIC_DEEP_OUTPUT_USD_PER_MTOK",
              introductory ? 10 : 15,
            ),
          };
        },
        maxInputCharacters: positiveInteger(
          "TABHUB_SUMMARY_MAX_INPUT_CHARS",
          200_000,
        ),
        timeoutMs: positiveInteger("TABHUB_SUMMARY_TIMEOUT_MS", 120_000),
      });
const embeddingProvider = createEmbeddingProviderFromEnv(process.env);

const app = createApp({
  databasePath,
  logger: true,
  webRoot: existsSync(webRoot) ? webRoot : false,
  ...(summaryProvider === undefined ? {} : { summaryProvider }),
  ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
  summaryDailyLimit: positiveInteger("TABHUB_DAILY_SUMMARY_LIMIT", 100),
  summaryMaxAttempts: positiveInteger("TABHUB_SUMMARY_MAX_ATTEMPTS", 5),
  summaryWorkerPollMs: positiveInteger("TABHUB_SUMMARY_POLL_MS", 1_000),
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
