import {
  parseDuplicateClosePlan,
  type DuplicateClosePlan,
} from "./duplicate-tabs";

const PREVIEW_KEY_PREFIX = "tabhub:duplicate-preview:";
const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DuplicatePreviewScope {
  browser: string;
  installationId: string;
}

interface PreviewStorage {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface RegistryOptions {
  createId?: () => string;
  now?: () => number;
}

interface StoredPreview {
  browser: string;
  expiresAt: number;
  installationId: string;
  plan: DuplicateClosePlan;
  previewId: string;
  version: 1;
}

function storageKey(installationId: string): string {
  return `${PREVIEW_KEY_PREFIX}${installationId}`;
}

function parseStoredPreview(value: unknown): StoredPreview | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 6 ||
    !keys.every((key) =>
      [
        "browser",
        "expiresAt",
        "installationId",
        "plan",
        "previewId",
        "version",
      ].includes(key),
    ) ||
    typeof record.browser !== "string" ||
    record.browser.length === 0 ||
    typeof record.installationId !== "string" ||
    !uuidPattern.test(record.installationId) ||
    typeof record.previewId !== "string" ||
    !uuidPattern.test(record.previewId) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) < 0 ||
    record.version !== 1
  ) {
    return undefined;
  }

  const plan = parseDuplicateClosePlan(record.plan);
  if (plan === undefined) return undefined;

  return {
    browser: record.browser,
    expiresAt: record.expiresAt as number,
    installationId: record.installationId,
    plan,
    previewId: record.previewId,
    version: 1,
  };
}

export function isDuplicatePreviewId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function createDuplicatePreviewRegistry(
  storage: PreviewStorage,
  options: RegistryOptions = {},
) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());

  return {
    async issue(
      scope: DuplicatePreviewScope,
      plan: DuplicateClosePlan,
    ): Promise<string> {
      const validatedPlan = parseDuplicateClosePlan(plan);
      if (validatedPlan === undefined) {
        throw new Error("Cannot store an invalid duplicate close plan.");
      }

      const previewId = createId();
      if (!isDuplicatePreviewId(previewId)) {
        throw new Error("Cannot create a valid duplicate preview identifier.");
      }

      await storage.set({
        [storageKey(scope.installationId)]: {
          browser: scope.browser,
          expiresAt: now() + PREVIEW_TTL_MS,
          installationId: scope.installationId,
          plan: validatedPlan,
          previewId,
          version: 1,
        } satisfies StoredPreview,
      });
      return previewId;
    },

    async consume(
      scope: DuplicatePreviewScope,
      previewId: string,
    ): Promise<DuplicateClosePlan> {
      const key = storageKey(scope.installationId);
      const stored = await storage.get(key);
      const preview = parseStoredPreview(stored[key]);

      if (preview === undefined) {
        throw new Error("This duplicate preview is no longer available. Preview again.");
      }
      if (preview.previewId !== previewId) {
        throw new Error("This duplicate preview is no longer current. Preview again.");
      }

      await storage.remove(key);

      if (
        preview.expiresAt < now() ||
        preview.browser !== scope.browser ||
        preview.installationId !== scope.installationId
      ) {
        throw new Error("This duplicate preview expired or its browser identity changed.");
      }

      return preview.plan;
    },
  };
}
