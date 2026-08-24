import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";

import { createApp } from "./app.js";
import { resolvePersonalAttentionFeatureFlags } from "./attention-feature-flags.js";
import { createWindowsBrowserForegroundHandoff } from "./browser-foreground.js";
import { createAnthropicSummaryProvider } from "./summary-provider.js";
import { createAnthropicResearchProvider } from "./research-provider.js";
import { createEmbeddingProviderFromEnv } from "./embedding-provider.js";
import { resolveServerHost } from "./runtime-config.js";
import { createRuntimeAvailabilityRecorder } from "./runtime-availability.js";
import { listenWithCleanup } from "./server-lifecycle.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(workspaceRoot, ".env") });

const host = resolveServerHost(process.env.TABHUB_HOST);
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

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = positiveInteger(name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
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
const researchIntroductoryPricing = Date.now() < sonnetStandardPricingStartsAt;
const researchPricing = Object.freeze({
  inputUsdPerMillionTokens: positiveNumber(
    "ANTHROPIC_RESEARCH_INPUT_USD_PER_MTOK",
    researchIntroductoryPricing ? 2 : 3,
  ),
  outputUsdPerMillionTokens: positiveNumber(
    "ANTHROPIC_RESEARCH_OUTPUT_USD_PER_MTOK",
    researchIntroductoryPricing ? 10 : 15,
  ),
});
const configuredResearchPricingVersion =
  process.env.ANTHROPIC_RESEARCH_PRICING_VERSION?.trim();
const researchProvider =
  anthropicApiKey === undefined || anthropicApiKey === ""
    ? undefined
    : createAnthropicResearchProvider({
        apiKey: anthropicApiKey,
        model:
          process.env.ANTHROPIC_RESEARCH_MODEL ??
          process.env.ANTHROPIC_DEEP_MODEL ??
          "claude-sonnet-5",
        promptVersion: "tabhub-resource-research-v1",
        pricingVersion: configuredResearchPricingVersion ||
          `anthropic-usd-mtok-${researchPricing.inputUsdPerMillionTokens}-${researchPricing.outputUsdPerMillionTokens}-v1`,
        pricing: researchPricing,
        maxOutputTokens: positiveInteger(
          "TABHUB_RESEARCH_MAX_OUTPUT_TOKENS",
          8_192,
        ),
        timeoutMs: positiveInteger("TABHUB_RESEARCH_TIMEOUT_MS", 120_000),
      });
const embeddingProvider = createEmbeddingProviderFromEnv(process.env);
const foregroundHelperPath = resolve(
  workspaceRoot,
  "packages/server/native/bin/tabhub-foreground.exe",
);
const browserForegroundHandoff =
  process.platform === "win32"
    ? createWindowsBrowserForegroundHandoff({
        executablePath: foregroundHelperPath,
      })
    : undefined;

const app = createApp({
  ...(browserForegroundHandoff === undefined
    ? {}
    : { browserForegroundHandoff }),
  databasePath,
  featureFlags: resolvePersonalAttentionFeatureFlags(process.env),
  logger: true,
  ...(process.env.TABHUB_DEV_PROXY_SECRET?.trim()
    ? { localDevProxySecret: process.env.TABHUB_DEV_PROXY_SECRET.trim() }
    : {}),
  tabCommandRelayAppOrigins: [
    `http://${host}:${port}`,
    `http://localhost:${port}`,
  ],
  webRoot: existsSync(webRoot) ? webRoot : false,
  ...(summaryProvider === undefined ? {} : { summaryProvider }),
  ...(researchProvider === undefined ? {} : { researchProvider }),
  ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
  summaryDailyLimit: positiveInteger("TABHUB_DAILY_SUMMARY_LIMIT", 100),
  summaryMaxAttempts: positiveInteger("TABHUB_SUMMARY_MAX_ATTEMPTS", 5),
  summaryWorkerPollMs: positiveInteger("TABHUB_SUMMARY_POLL_MS", 1_000),
  liveAcquisitionMaxAttemptsPerUtcDay: boundedInteger(
    "TABHUB_LIVE_ACQUISITION_MAX_ATTEMPTS_PER_UTC_DAY",
    20,
    1,
    100,
  ),
});

/**
 * Issue #37: the host lost power, the runtime died with it, and eight hours
 * passed before anyone noticed. The Trial week counts days of real use, so
 * "not running" has to be tellable from "not used" afterwards. A hard kill
 * writes nothing on its way out, so availability is recorded as it happens and
 * the gaps are read back later.
 */
try {
  await listenWithCleanup(app, { host, port }, (closeError) => {
    app.log.error(closeError, "Failed to close TabHub after startup failure");
  });

  // Only past this line is this process the runtime. Recording a start before
  // the port is held would let a losing duplicate — exactly what a repeating
  // restart task risks — declare the live server dead and invent an outage.
  const availability = createRuntimeAvailabilityRecorder({
    logPath: resolve(workspaceRoot, "data/runtime-availability.jsonl"),
    heartbeatPath: resolve(workspaceRoot, "data/runtime-heartbeat.json"),
    sessionId: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
  });
  const heartbeat = setInterval(
    () => availability.beat(new Date().toISOString()),
    30_000,
  );
  // Unref'd so the record never keeps alive a process that is trying to exit.
  heartbeat.unref();

  let shuttingDown = false;
  const recordStop = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    availability.stop(new Date().toISOString());
  };
  process.once("exit", recordStop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      recordStop();
      // Close before leaving: an abrupt exit here would leave the database
      // handle open, which is the very shape of shutdown this issue is about.
      void app.close().finally(() => process.exit(0));
    });
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

