import {
  contextChangeResultSchema,
  exactTabScopeQuerySchema,
  featureFlagsResponseSchema,
  ingestSnapshotSchema,
  localScopedContextAppendCommandSchema,
  localSessionIntentCommandSchema,
  sessionIntentBundleSchema,
  sessionIntentChangeResultSchema,
  type ExactTabScope,
  type FeatureFlagsResponse,
  type IngestSnapshot,
  type LocalSessionIntentCommand,
  type SessionIntentBundle,
} from "@tabhub/shared";
import { browser } from "wxt/browser";

import {
  FEATURES_ENDPOINT,
  LOCAL_PAGE_CONTEXT_ENDPOINT,
  LOCAL_SESSION_INTENT_COMMANDS_ENDPOINT,
  LOCAL_SESSION_INTENTS_ENDPOINT,
  STORAGE_KEYS,
} from "./constants";
import {
  localCapabilityFetch,
  PairingRequiredError,
  restrictLocalStorageToTrustedContexts,
} from "./local-capability";
import { postSnapshot } from "./api";

type LocalScopedContextAppendCommand = ReturnType<
  typeof localScopedContextAppendCommandSchema.parse
>;

interface PendingContextMutationMetadata {
  attempts: number;
  createdAt: string;
  id: string;
  lastAttemptAt?: string;
  lastError?:
    | "Pairing required"
    | "Retry required"
    | "Page changed; review required";
}

export type PendingContextMutation = PendingContextMutationMetadata &
  (
    | {
        kind: "page-context";
        command: LocalScopedContextAppendCommand;
        snapshot: IngestSnapshot;
      }
    | {
        kind: "session-intent";
        command: LocalSessionIntentCommand;
        snapshot: IngestSnapshot;
      }
  );

export interface ContextMutationDrainResult {
  pairingRequired: boolean;
  remaining: PendingContextMutation[];
  sent: number;
}

interface CachedContextFeatures {
  context: boolean;
  logicalImportance: boolean;
  observedAt: string;
}

const CORRUPT_QUEUE_ERROR =
  "Personal-context queue is corrupted; no later mutations were sent";
const QUEUE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,12})?Z$/;

export class StaleContextMutationError extends Error {
  constructor() {
    super("Page changed; review required");
    this.name = "StaleContextMutationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isBoundedIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) {
    return false;
  }
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (match === null) return false;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return false;
  return (
    instant.getUTCFullYear() === Number(match[1]) &&
    instant.getUTCMonth() + 1 === Number(match[2]) &&
    instant.getUTCDate() === Number(match[3]) &&
    instant.getUTCHours() === Number(match[4]) &&
    instant.getUTCMinutes() === Number(match[5]) &&
    instant.getUTCSeconds() === Number(match[6])
  );
}

function hasValidOptionalQueueMetadata(
  value: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(value, "lastAttemptAt") &&
    !isBoundedIsoDateTime(value.lastAttemptAt)
  ) {
    return false;
  }
  return (
    !Object.hasOwn(value, "lastError") ||
    value.lastError === "Pairing required" ||
    value.lastError === "Retry required" ||
    value.lastError === "Page changed; review required"
  );
}

export function parsePendingContextMutation(
  value: unknown,
): PendingContextMutation | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "page-context" && value.kind !== "session-intent") ||
    typeof value.id !== "string" ||
    !QUEUE_ID_PATTERN.test(value.id) ||
    !isBoundedIsoDateTime(value.createdAt) ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    !hasValidOptionalQueueMetadata(value) ||
    !hasOnlyKeys(value, [
      "attempts",
      "command",
      "createdAt",
      "id",
      "kind",
      "lastAttemptAt",
      "lastError",
      "snapshot",
    ])
  ) {
    return undefined;
  }
  const snapshot = ingestSnapshotSchema.safeParse(value.snapshot);
  const command =
    value.kind === "page-context"
      ? localScopedContextAppendCommandSchema.safeParse(value.command)
      : localSessionIntentCommandSchema.safeParse(value.command);
  if (!snapshot.success || !command.success) return undefined;
  const metadata: PendingContextMutationMetadata = {
    attempts: value.attempts as number,
    createdAt: value.createdAt,
    id: value.id,
  };
  if (typeof value.lastAttemptAt === "string") {
    metadata.lastAttemptAt = value.lastAttemptAt;
  }
  if (
    value.lastError === "Pairing required" ||
    value.lastError === "Retry required" ||
    value.lastError === "Page changed; review required"
  ) {
    metadata.lastError = value.lastError;
  }
  return value.kind === "page-context"
    ? {
        ...metadata,
        kind: value.kind,
        command: command.data as LocalScopedContextAppendCommand,
        snapshot: snapshot.data,
      }
    : {
        ...metadata,
        kind: value.kind,
        command: command.data as LocalSessionIntentCommand,
        snapshot: snapshot.data,
      };
}

export function createPendingContextMutation(
  input:
    | {
        kind: "page-context";
        command: LocalScopedContextAppendCommand;
        snapshot: IngestSnapshot;
      }
    | {
        kind: "session-intent";
        command: LocalSessionIntentCommand;
        snapshot: IngestSnapshot;
      },
  id: string = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
): PendingContextMutation {
  const parsed = parsePendingContextMutation({
    ...input,
    attempts: 0,
    createdAt,
    id,
  });
  if (parsed === undefined) throw new Error("Invalid context mutation");
  return parsed;
}

export async function readPendingContextMutations(): Promise<
  PendingContextMutation[]
> {
  await restrictLocalStorageToTrustedContexts();
  const stored = await browser.storage.local.get(
    STORAGE_KEYS.pendingContextMutations,
  );
  const value = stored[STORAGE_KEYS.pendingContextMutations];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(CORRUPT_QUEUE_ERROR);
  return value.map((item) => {
    const parsed = parsePendingContextMutation(item);
    if (parsed === undefined) throw new Error(CORRUPT_QUEUE_ERROR);
    return parsed;
  });
}

export async function writePendingContextMutations(
  queue: readonly PendingContextMutation[],
): Promise<void> {
  await restrictLocalStorageToTrustedContexts();
  const byteSize = new TextEncoder().encode(JSON.stringify(queue)).byteLength;
  if (byteSize > 32 * 1024 * 1024) {
    throw new Error("TabHub's personal-context queue is full");
  }
  await browser.storage.local.set({
    [STORAGE_KEYS.pendingContextMutations]: queue,
  });
}

export async function fetchContextFeatures(): Promise<FeatureFlagsResponse> {
  const response = await fetch(FEATURES_ENDPOINT, { cache: "no-store" });
  if (!response.ok) throw new Error("Feature discovery failed");
  const parsed = featureFlagsResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Feature discovery failed");
  await restrictLocalStorageToTrustedContexts();
  await browser.storage.local.set({
    [STORAGE_KEYS.contextFeatures]: {
      ...parsed.data,
      observedAt: new Date().toISOString(),
    } satisfies CachedContextFeatures,
  });
  return parsed.data;
}

export async function readCachedContextFeatures(): Promise<
  FeatureFlagsResponse | undefined
> {
  await restrictLocalStorageToTrustedContexts();
  const stored = await browser.storage.local.get(STORAGE_KEYS.contextFeatures);
  const value = stored[STORAGE_KEYS.contextFeatures];
  if (!isRecord(value) || typeof value.observedAt !== "string") return undefined;
  const parsed = featureFlagsResponseSchema.safeParse({
    context: value.context,
    logicalImportance: value.logicalImportance,
  });
  return parsed.success ? parsed.data : undefined;
}

export async function resolveContextFeatures(): Promise<FeatureFlagsResponse> {
  try {
    return await fetchContextFeatures();
  } catch (error) {
    const cached = await readCachedContextFeatures();
    if (cached !== undefined) return cached;
    throw error;
  }
}

export async function fetchSessionIntentBundle(
  scope: ExactTabScope,
): Promise<SessionIntentBundle> {
  const query = exactTabScopeQuerySchema.parse(scope);
  const search = new URLSearchParams({
    browserSessionId: query.browserSessionId,
    browserTabId: String(query.browserTabId),
    installationId: query.installationId,
  });
  const response = await localCapabilityFetch(
    `/api/local/session-intents?${search.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error("Session intent read failed");
  const parsed = sessionIntentBundleSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Session intent read failed");
  return parsed.data;
}

export async function deliverPendingContextMutation(
  item: PendingContextMutation,
  adapters: {
    postCommand?: (item: PendingContextMutation) => Promise<void>;
    postSnapshot?: (snapshot: IngestSnapshot) => Promise<void>;
    verifyBeforeCommand?: (item: PendingContextMutation) => Promise<void>;
  } = {},
): Promise<void> {
  const snapshotSender = adapters.postSnapshot ?? postSnapshot;
  // Ordering is a safety contract: catalog snapshot first, mutation second.
  await snapshotSender(item.snapshot);
  await adapters.verifyBeforeCommand?.(item);
  if (adapters.postCommand !== undefined) {
    await adapters.postCommand(item);
    return;
  }
  const endpoint =
    item.kind === "page-context"
      ? LOCAL_PAGE_CONTEXT_ENDPOINT
      : LOCAL_SESSION_INTENT_COMMANDS_ENDPOINT;
  const response = await localCapabilityFetch(
    new URL(endpoint).pathname,
    {
      body: JSON.stringify(item.command),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  if (response.status === 409) throw new StaleContextMutationError();
  if (!response.ok) throw new Error("Context mutation failed");
  const payload = await response.json();
  const parsed =
    item.kind === "page-context"
      ? contextChangeResultSchema.safeParse(payload)
      : sessionIntentChangeResultSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Context mutation failed");
}

export async function drainPendingContextMutations(
  initialQueue: readonly PendingContextMutation[],
  persist: (
    queue: readonly PendingContextMutation[],
  ) => Promise<void> = writePendingContextMutations,
  send: (item: PendingContextMutation) => Promise<void> =
    deliverPendingContextMutation,
  now: () => string = () => new Date().toISOString(),
): Promise<ContextMutationDrainResult> {
  let remaining = [...initialQueue];
  let sent = 0;
  let pairingRequired = false;
  while (remaining.length > 0) {
    const next = remaining[0]!;
    // A stale exact-page conflict is a user-review barrier. Periodic retries
    // must never silently re-send it (or pass it to reach successors).
    if (next.lastError === "Page changed; review required") break;
    try {
      await send(next);
    } catch (error) {
      pairingRequired = error instanceof PairingRequiredError;
      const stale = error instanceof StaleContextMutationError;
      remaining[0] = {
        ...next,
        attempts: next.attempts + 1,
        lastAttemptAt: now(),
        lastError: pairingRequired
          ? "Pairing required"
          : stale
            ? "Page changed; review required"
            : "Retry required",
      };
      await persist(remaining);
      break;
    }
    sent += 1;
    remaining = remaining.slice(1);
    await persist(remaining);
  }
  return { pairingRequired, remaining, sent };
}

export async function discardStalePendingContextMutationHead(
  expectedHeadId: string,
  adapters: {
    send?: (item: PendingContextMutation) => Promise<void>;
  } = {},
): Promise<ContextMutationDrainResult> {
  const pending = await readPendingContextMutations();
  const head = pending[0];
  if (
    head === undefined ||
    head.id !== expectedHeadId ||
    head.lastError !== "Page changed; review required"
  ) {
    throw new Error("The queued context changed; review it again");
  }
  const remaining = pending.slice(1);
  await writePendingContextMutations(remaining);
  return drainPendingContextMutations(
    remaining,
    writePendingContextMutations,
    adapters.send ?? deliverPendingContextMutation,
  );
}
