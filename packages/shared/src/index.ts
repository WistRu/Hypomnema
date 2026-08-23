import { z } from "zod";

import {
  ingestSnapshotBodyLimitBytes,
  snapshotTabFaviconUrlMaxLength,
  snapshotTabTitleMaxLength,
  tabUrlMaxLength,
} from "@tabhub/shared/limits";
import {
  researchCanonicalSha256PayloadV1,
  researchOriginConfirmationRequirementsSchema,
} from "./research-contracts.ts";

export * from "@tabhub/shared/limits";
export * from "./research-contracts.ts";
export * from "./live-acquisition-contracts.ts";
export * from "./privacy-purge-contracts.ts";

export const knownBrowserOptions = [
  "chrome",
  "yandex",
  "edge",
  "other",
] as const;

export const browserIdentifierSchema = z.string().trim().min(1).max(64);

export type BrowserIdentifier = z.infer<typeof browserIdentifierSchema>;

export const installationIdSchema = z.string().uuid();

export type InstallationId = z.infer<typeof installationIdSchema>;

export const localExtensionOriginHeaderName =
  "x-tabhub-extension-origin" as const;

export const extensionOriginSchema = z
  .string()
  .regex(/^chrome-extension:\/\/[a-z0-9_-]+$/i);

export const browserSessionIdSchema = z.string().uuid();

export type BrowserSessionId = z.infer<typeof browserSessionIdSchema>;

export const browserConfigSchema = z.object({
  browser: browserIdentifierSchema,
});

export type BrowserConfig = z.infer<typeof browserConfigSchema>;

export const tabUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(tabUrlMaxLength)
  .refine((value) => URL.canParse(value), "Invalid URL");

export const snapshotTabSchema = z.object({
  tabId: z.number().int().nonnegative().optional(),
  url: tabUrlSchema,
  title: z.string().max(snapshotTabTitleMaxLength).optional(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().max(snapshotTabFaviconUrlMaxLength).optional(),
  active: z.boolean().optional(),
  audible: z.boolean().optional(),
  muted: z.boolean().optional(),
  discarded: z.boolean().optional(),
  pinned: z.boolean().optional(),
  lastAccessed: z.number().finite().nonnegative().optional(),
});

export type SnapshotTab = z.infer<typeof snapshotTabSchema>;

export const ingestSnapshotSchema = z
  .object({
    browser: browserIdentifierSchema,
    browserSessionId: browserSessionIdSchema.optional(),
    installationId: installationIdSchema.optional(),
    tabs: z.array(snapshotTabSchema),
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.browserSessionId !== undefined &&
      snapshot.installationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser session identity requires an installation identity",
        path: ["browserSessionId"],
      });
    }

    if (snapshot.installationId !== undefined) {
      const seenTabIds = new Set<number>();
      snapshot.tabs.forEach((tab, index) => {
        if (tab.tabId === undefined) {
          context.addIssue({
            code: "custom",
            message: "Modern snapshots require a native tab ID",
            path: ["tabs", index, "tabId"],
          });
        } else if (seenTabIds.has(tab.tabId)) {
          context.addIssue({
            code: "custom",
            message: "Native tab IDs must be unique within a snapshot",
            path: ["tabs", index, "tabId"],
          });
        } else {
          seenTabIds.add(tab.tabId);
        }
      });
    }

    const serialized = JSON.stringify(snapshot);
    const byteLength = new TextEncoder().encode(serialized).byteLength;

    if (byteLength > ingestSnapshotBodyLimitBytes) {
      context.addIssue({
        code: "custom",
        message: `Snapshot JSON cannot exceed ${ingestSnapshotBodyLimitBytes} bytes`,
      });
    }
  });

export type IngestSnapshot = z.infer<typeof ingestSnapshotSchema>;

export const ingestSnapshotResponseSchema = z.object({
  upserted: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

export type IngestSnapshotResponse = z.infer<
  typeof ingestSnapshotResponseSchema
>;

export const ingestContentSchema = z.object({
  browser: browserIdentifierSchema,
  url: tabUrlSchema,
  text: z.string().max(2_000_000),
  htmlExcerpt: z.string().max(250_000),
});

export type IngestContent = z.infer<typeof ingestContentSchema>;

export const ingestContentResponseSchema = z.object({
  tabId: z.number().int().positive(),
  extractedAt: z.string().datetime(),
});

export type IngestContentResponse = z.infer<
  typeof ingestContentResponseSchema
>;

export const activityMaxIntervalMs = 120_000;

export const ingestActivitySchema = z
  .strictObject({
    id: z.string().uuid(),
    browser: browserIdentifierSchema,
    installationId: installationIdSchema,
    browserSessionId: browserSessionIdSchema,
    browserTabId: z.number().int().nonnegative(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    url: tabUrlSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    foregroundMs: z.number().int().positive().max(activityMaxIntervalMs),
    engagedMs: z.number().int().nonnegative().max(activityMaxIntervalMs),
  })
  .superRefine((activity, context) => {
    const elapsedMs =
      Date.parse(activity.endedAt) - Date.parse(activity.startedAt);

    if (elapsedMs <= 0) {
      context.addIssue({
        code: "custom",
        message: "Activity must end after it starts",
        path: ["endedAt"],
      });
    }

    if (elapsedMs > activityMaxIntervalMs) {
      context.addIssue({
        code: "custom",
        message: "Activity interval cannot exceed 120000 milliseconds",
        path: ["endedAt"],
      });
    }

    if (activity.foregroundMs > elapsedMs) {
      context.addIssue({
        code: "custom",
        message: "Foreground time cannot exceed the activity interval",
        path: ["foregroundMs"],
      });
    }

    if (activity.engagedMs > activity.foregroundMs) {
      context.addIssue({
        code: "custom",
        message: "Engaged time cannot exceed foreground time",
        path: ["engagedMs"],
      });
    }
  });

export type IngestActivity = z.infer<typeof ingestActivitySchema>;

export const ingestActivityResponseSchema = z.object({
  accepted: z.boolean(),
});

export type IngestActivityResponse = z.infer<
  typeof ingestActivityResponseSchema
>;

export const activityWindowSchema = z.enum(["7d", "30d", "all"]);

export type ActivityWindow = z.infer<typeof activityWindowSchema>;

export const activityWindowQuerySchema = z
  .object({ window: activityWindowSchema.default("all") })
  .strict();

export const activityRollupSchema = z
  .object({
    window: activityWindowSchema,
    onScreenMs: z.number().int().nonnegative(),
    activeUseMs: z.number().int().nonnegative(),
    coverageStart: z.string().datetime().nullable(),
    windowStart: z.string().datetime().nullable(),
    windowEnd: z.string().datetime(),
  })
  .strict()
  .superRefine((activity, context) => {
    if (activity.activeUseMs > activity.onScreenMs) {
      context.addIssue({
        code: "custom",
        message: "Active use cannot exceed on-screen time",
        path: ["activeUseMs"],
      });
    }
    if (activity.window !== "all" && activity.coverageStart === null) {
      context.addIssue({
        code: "custom",
        message: "Daily activity windows require persisted coverage",
        path: ["coverageStart"],
      });
    }
    if (
      activity.window !== "all" &&
      (activity.windowStart === null ||
        Date.parse(activity.windowEnd) <= Date.parse(activity.windowStart))
    ) {
      context.addIssue({
        code: "custom",
        message: "Daily activity windows require ordered UTC boundaries",
        path: ["windowStart"],
      });
    }
  });

export type ActivityRollup = z.infer<typeof activityRollupSchema>;

export const logicalPageActivityResponseSchema = z
  .object({
    logicalPageId: z.number().int().positive(),
    activity: activityRollupSchema,
  })
  .strict();

export type LogicalPageActivityResponse = z.infer<
  typeof logicalPageActivityResponseSchema
>;

export const activityIngestMetricsResponseSchema = z
  .object({
    duplicateEvents: z.number().int().nonnegative(),
    outOfOrderRejections: z.number().int().nonnegative(),
    gapEvents: z.number().int().nonnegative(),
    missingSequences: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ActivityIngestMetricsResponse = z.infer<
  typeof activityIngestMetricsResponseSchema
>;

export const tabStatusSchema = z.enum([
  "inbox",
  "in_progress",
  "done",
  "archived",
]);

export type TabStatus = z.infer<typeof tabStatusSchema>;

export const tabImportanceSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export type TabImportance = z.infer<typeof tabImportanceSchema>;

export const searchModeSchema = z.enum(["fulltext", "semantic"]);

export type SearchMode = z.infer<typeof searchModeSchema>;

export const tabIdSchema = z.number().int().positive();

export const logicalPageIdSchema = z.number().int().positive();

export type LogicalPageId = z.infer<typeof logicalPageIdSchema>;

export const userImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export type UserImportance = z.infer<typeof userImportanceSchema>;

export const logicalPageRefSchema = z.object({
  id: logicalPageIdSchema,
  identityKey: z.string().trim().min(1),
  urlNormalized: z.string().trim().min(1),
  representativeUrl: tabUrlSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type LogicalPageRef = z.infer<typeof logicalPageRefSchema>;

export const browserPageRefSchema = z.object({
  tabId: tabIdSchema,
  logicalPageId: logicalPageIdSchema,
  browser: browserIdentifierSchema,
  url: tabUrlSchema,
  urlNormalized: z.string().trim().min(1),
});

export type BrowserPageRef = z.infer<typeof browserPageRefSchema>;

const logicalPagePreferenceBase = {
  logicalPageId: logicalPageIdSchema,
  updatedAt: z.string().datetime(),
};

export const logicalPagePreferenceSchema = z.union([
  z.object({
    ...logicalPagePreferenceBase,
    userImportance: z.null(),
    recordedBy: z.null(),
    recordMethod: z.null(),
    importanceUpdatedAt: z.null(),
  }),
  z.object({
    ...logicalPagePreferenceBase,
    userImportance: userImportanceSchema,
    recordedBy: z.literal("user"),
    recordMethod: z.literal("manual"),
    importanceUpdatedAt: z.string().datetime(),
  }),
  z.object({
    ...logicalPagePreferenceBase,
    userImportance: userImportanceSchema,
    recordedBy: z.literal("agent"),
    recordMethod: z.literal("on_behalf_of_user"),
    importanceUpdatedAt: z.string().datetime(),
  }),
]);

export type LogicalPagePreference = z.infer<
  typeof logicalPagePreferenceSchema
>;

export const legacyImportanceSourceSchema = z.object({
  tabId: tabIdSchema,
  browser: browserIdentifierSchema,
  value: tabImportanceSchema,
});

export type LegacyImportanceSource = z.infer<
  typeof legacyImportanceSourceSchema
>;

export const legacyImportanceResolutionStateSchema = z.enum([
  "legacy_unknown",
  "conflict",
  "confirmed",
]);

export type LegacyImportanceResolutionState = z.infer<
  typeof legacyImportanceResolutionStateSchema
>;

export const logicalPageImportanceMigrationAuditSchema = z
  .object({
    logicalPageId: logicalPageIdSchema,
    legacyValues: z.array(legacyImportanceSourceSchema).min(1),
    suggestedValue: userImportanceSchema.nullable(),
    resolutionState: legacyImportanceResolutionStateSchema,
    createdAt: z.string().datetime(),
    reviewedAt: z.string().datetime().nullable(),
  })
  .superRefine((audit, context) => {
    if (
      audit.resolutionState === "legacy_unknown" &&
      audit.suggestedValue === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Legacy unknown importance requires a suggested value",
        path: ["suggestedValue"],
      });
    }

    if (
      audit.resolutionState === "conflict" &&
      audit.suggestedValue !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Conflicting legacy importance cannot select a winner",
        path: ["suggestedValue"],
      });
    }
  });

export type LogicalPageImportanceMigrationAudit = z.infer<
  typeof logicalPageImportanceMigrationAuditSchema
>;

export const logicalPageViewSchema = z.object({
  page: logicalPageRefSchema,
  preference: logicalPagePreferenceSchema,
  legacyImportanceAudit: logicalPageImportanceMigrationAuditSchema.nullable(),
  browserPages: z.array(browserPageRefSchema),
});

export type LogicalPageView = z.infer<typeof logicalPageViewSchema>;

export const contextEntryKindSchema = z.enum([
  "purpose",
  "interest",
  "question",
  "project",
  "next_action",
  "disposition",
  "note",
]);

export type ContextEntryKind = z.infer<typeof contextEntryKindSchema>;

export const contextVisibilitySchema = z.enum([
  "local_only",
  "share_with_ai",
]);

export type ContextVisibility = z.infer<typeof contextVisibilitySchema>;

export const contextPageSubjectSchema = z
  .object({
    type: z.literal("page"),
    logicalPageId: logicalPageIdSchema,
  })
  .strict();

export const contextResourceSubjectSchema = z
  .object({
    type: z.literal("resource"),
    resourceId: z.number().int().positive(),
  })
  .strict();

export const contextSubjectSchema = z.discriminatedUnion("type", [
  contextPageSubjectSchema,
  contextResourceSubjectSchema,
]);

export type ContextPageSubject = z.infer<typeof contextPageSubjectSchema>;
export type ContextSubject = z.infer<typeof contextSubjectSchema>;

export const modelProvenanceSchema = z
  .object({
    provider: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    promptVersion: z.string().trim().min(1).max(128),
  })
  .strict();

export type ModelProvenance = z.infer<typeof modelProvenanceSchema>;

const contextSourceFingerprintSchema = z.string().trim().min(1).max(512);
const contextIdempotencyKeySchema = z.string().trim().min(1).max(256);

export const contextUserProvenanceSchema = z
  .object({
    actor: z.literal("user"),
    method: z.literal("manual"),
  })
  .strict();

export const contextAgentOnBehalfProvenanceSchema = z
  .object({
    actor: z.literal("agent"),
    method: z.literal("on_behalf_of_user"),
  })
  .strict();

export const contextAgentRuleProvenanceSchema = z
  .object({
    actor: z.literal("agent"),
    method: z.literal("rule"),
    sourceFingerprint: contextSourceFingerprintSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const contextAgentModelProvenanceSchema = z
  .object({
    actor: z.literal("agent"),
    method: z.literal("model"),
    sourceFingerprint: contextSourceFingerprintSchema,
    model: modelProvenanceSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const contextSystemProvenanceSchema = z
  .object({
    actor: z.literal("system"),
    method: z.literal("derived"),
    sourceFingerprint: contextSourceFingerprintSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const contextProvenanceSchema = z.union([
  contextUserProvenanceSchema,
  contextAgentOnBehalfProvenanceSchema,
  contextAgentRuleProvenanceSchema,
  contextAgentModelProvenanceSchema,
  contextSystemProvenanceSchema,
]);

export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;

export const contextReviewProvenanceSchema = z.union([
  contextUserProvenanceSchema,
  z
    .object({
      actor: z.literal("agent"),
      method: z.literal("on_behalf_of_user"),
    })
    .strict(),
]);

export type ContextReviewProvenance = z.infer<
  typeof contextReviewProvenanceSchema
>;

export const contextEntryStateSchema = z.enum(["active", "withdrawn"]);
export const contextEntryOperationSchema = z.enum([
  "append",
  "withdraw",
  "restore",
]);
export const contextReviewVerdictSchema = z.enum(["accepted", "rejected"]);

export const contextEntryReviewSchema = z
  .object({
    id: z.number().int().positive(),
    contextEntryId: z.number().int().positive(),
    verdict: contextReviewVerdictSchema,
    provenance: contextReviewProvenanceSchema,
    idempotencyKey: contextIdempotencyKeySchema,
    supersedesId: z.number().int().positive().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ContextEntryReview = z.infer<typeof contextEntryReviewSchema>;

export const contextEntrySchema = z
  .object({
    id: z.number().int().positive(),
    subject: contextSubjectSchema,
    entryKind: contextEntryKindSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: contextProvenanceSchema,
    visibility: contextVisibilitySchema,
    staleAt: z.string().datetime().nullable(),
    supersedesId: z.number().int().positive().nullable(),
    state: contextEntryStateSchema,
    operation: contextEntryOperationSchema,
    revision: z.number().int().positive(),
    idempotencyKey: contextIdempotencyKeySchema,
    createdAt: z.string().datetime(),
    withdrawnAt: z.string().datetime().nullable(),
    currentReview: contextEntryReviewSchema.nullable(),
  })
  .strict();

export type ContextEntry = z.infer<typeof contextEntrySchema>;

export const contextPreviewSchema = z
  .object({
    entryId: z.number().int().positive(),
    entryKind: z.enum(["next_action", "purpose", "note"]),
    body: z.string().trim().min(1).max(100_000),
    actor: z.enum(["user", "agent"]),
  })
  .strict();

export type ContextPreview = z.infer<typeof contextPreviewSchema>;

export const contextBundleSchema = z
  .object({
    subject: contextSubjectSchema,
    entries: z.array(contextEntrySchema),
    currentEntries: z.array(contextEntrySchema),
    preview: contextPreviewSchema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    for (const [collection, entries] of [
      ["entries", bundle.entries],
      ["currentEntries", bundle.currentEntries],
    ] as const) {
      entries.forEach((entry, index) => {
        if (JSON.stringify(entry.subject) !== JSON.stringify(bundle.subject)) {
          context.addIssue({
            code: "custom",
            message: "Context entry subject must match its bundle subject",
            path: [collection, index, "subject"],
          });
        }
      });
    }
  });

export type ContextBundle = z.infer<typeof contextBundleSchema>;

export const localPageContextViewSchema = z
  .object({
    context: contextBundleSchema,
    affectedBrowserPageCount: z.number().int().nonnegative(),
  })
  .strict();

export type LocalPageContextView = z.infer<
  typeof localPageContextViewSchema
>;

export const shareableContextEntrySchema = z
  .object({
    entryKind: contextEntryKindSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: contextProvenanceSchema,
    visibility: z.literal("share_with_ai"),
    staleAt: z.string().datetime().nullable(),
    state: contextEntryStateSchema,
    createdAt: z.string().datetime(),
    reviewVerdict: contextReviewVerdictSchema.nullable(),
  })
  .strict();

export type ShareableContextEntry = z.infer<
  typeof shareableContextEntrySchema
>;

export const agentContextMutationReceiptSchema = z
  .object({
    kind: z.literal("appended"),
    entry: shareableContextEntrySchema,
  })
  .strict();

export const shareableContextPreviewSchema = contextPreviewSchema.omit({
  entryId: true,
});

export const shareableContextBundleSchema = z
  .object({
    subject: contextSubjectSchema,
    entries: z.array(shareableContextEntrySchema),
    currentEntries: z.array(shareableContextEntrySchema),
    preview: shareableContextPreviewSchema.nullable(),
  })
  .strict();

export type ShareableContextBundle = z.infer<
  typeof shareableContextBundleSchema
>;

export const contextAppendCommandSchema = z
  .object({
    kind: z.literal("append"),
    subject: contextSubjectSchema,
    entryKind: contextEntryKindSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: contextProvenanceSchema,
    visibility: contextVisibilitySchema,
    staleAt: z.string().datetime().nullable().optional(),
    supersedesEntryId: z.number().int().positive().optional(),
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const contextWithdrawCommandSchema = z
  .object({
    kind: z.literal("withdraw"),
    subject: contextSubjectSchema,
    entryId: z.number().int().positive(),
    provenance: contextReviewProvenanceSchema,
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const contextRestoreCommandSchema = z
  .object({
    kind: z.literal("restore"),
    subject: contextSubjectSchema,
    entryId: z.number().int().positive(),
    provenance: contextReviewProvenanceSchema,
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const contextReviewCommandSchema = z
  .object({
    kind: z.literal("review"),
    subject: contextSubjectSchema,
    entryId: z.number().int().positive(),
    verdict: contextReviewVerdictSchema,
    provenance: contextReviewProvenanceSchema,
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

const localContextAppendBaseSchema = contextAppendCommandSchema.omit({
  provenance: true,
  subject: true,
});

function validateDisposition(
  command: { entryKind: ContextEntryKind; body: string },
  context: z.RefinementCtx,
): void {
  if (
    command.entryKind === "disposition" &&
    command.body !== "not_useful" &&
    command.body !== "already_handled"
  ) {
    context.addIssue({
      code: "custom",
      message: "Disposition must be not_useful or already_handled",
      path: ["body"],
      input: command.body,
    });
  }
}

export const localContextAppendCommandSchema =
  localContextAppendBaseSchema.superRefine(validateDisposition);

export const localContextCommandSchema = z.discriminatedUnion("kind", [
  localContextAppendCommandSchema,
  contextWithdrawCommandSchema.omit({ provenance: true, subject: true }),
  contextRestoreCommandSchema.omit({ provenance: true, subject: true }),
  contextReviewCommandSchema.omit({ provenance: true, subject: true }),
]);

export type LocalContextCommand = z.infer<typeof localContextCommandSchema>;

export const agentContextAppendCommandSchema = localContextAppendBaseSchema
  .omit({ visibility: true, supersedesEntryId: true })
  .extend({
    provenance: z.union([
      z.object({ method: z.literal("on_behalf_of_user") }).strict(),
      z
        .object({
          method: z.literal("model"),
          sourceFingerprint: contextSourceFingerprintSchema,
          model: modelProvenanceSchema,
          confidence: z.number().finite().min(0).max(1).optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine(validateDisposition);

export type AgentContextAppendCommand = z.infer<
  typeof agentContextAppendCommandSchema
>;

export const contextCommandSchema = z.discriminatedUnion("kind", [
  contextAppendCommandSchema,
  contextWithdrawCommandSchema,
  contextRestoreCommandSchema,
  contextReviewCommandSchema,
]);

export type ContextCommand = z.infer<typeof contextCommandSchema>;

export const contextChangeResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("changed"),
      operation: contextEntryOperationSchema,
      entry: contextEntrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reviewed"),
      review: contextEntryReviewSchema,
    })
    .strict(),
]);

export type ContextChangeResult = z.infer<typeof contextChangeResultSchema>;

export const exactTabScopeSchema = z
  .object({
    installationId: installationIdSchema,
    browserSessionId: browserSessionIdSchema,
    browserTabId: z.number().int().nonnegative(),
  })
  .strict();

export type ExactTabScope = z.infer<typeof exactTabScopeSchema>;

export const localScopedContextAppendCommandSchema =
  localContextAppendBaseSchema
    .extend({
      scope: exactTabScopeSchema,
      expectedUrl: tabUrlSchema,
    })
    .strict()
    .superRefine(validateDisposition);

export const expectedTabPageSchema = z
  .object({
    logicalPageId: logicalPageIdSchema,
    url: tabUrlSchema,
    urlNormalized: z.string().trim().min(1).max(tabUrlMaxLength),
    instanceRevision: z.number().int().positive(),
  })
  .strict();

export type ExpectedTabPage = z.infer<typeof expectedTabPageSchema>;

export const sessionIntentProvenanceSchema = z.union([
  contextUserProvenanceSchema,
  contextAgentOnBehalfProvenanceSchema,
  contextAgentModelProvenanceSchema,
]);

export type SessionIntentProvenance = z.infer<
  typeof sessionIntentProvenanceSchema
>;

export const sessionIntentStateSchema = z.enum([
  "active",
  "archived",
  "promoted",
  "expired",
]);

export type SessionIntentState = z.infer<typeof sessionIntentStateSchema>;

export const sessionIntentSchema = z
  .object({
    id: z.number().int().positive(),
    scope: exactTabScopeSchema,
    subject: contextPageSubjectSchema,
    expectedPage: expectedTabPageSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: sessionIntentProvenanceSchema,
    visibility: contextVisibilitySchema,
    staleAt: z.string().datetime().nullable(),
    state: sessionIntentStateSchema,
    idempotencyKey: contextIdempotencyKeySchema,
    archivedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    promotedContextEntryId: z.number().int().positive().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SessionIntent = z.infer<typeof sessionIntentSchema>;

export const sessionIntentBundleSchema = z
  .object({
    scope: exactTabScopeSchema,
    current: sessionIntentSchema.nullable(),
    history: z.array(sessionIntentSchema),
  })
  .strict();

export type SessionIntentBundle = z.infer<typeof sessionIntentBundleSchema>;

export const shareableSessionIntentSchema = z
  .object({
    scope: exactTabScopeSchema,
    subject: contextPageSubjectSchema,
    expectedPage: expectedTabPageSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: sessionIntentProvenanceSchema,
    visibility: z.literal("share_with_ai"),
    staleAt: z.string().datetime().nullable(),
    state: sessionIntentStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ShareableSessionIntent = z.infer<
  typeof shareableSessionIntentSchema
>;

export const agentSessionIntentMutationReceiptSchema = z
  .object({
    kind: z.literal("set"),
    intent: shareableSessionIntentSchema,
  })
  .strict();

export const shareableSessionIntentBundleSchema = z
  .object({
    scope: exactTabScopeSchema,
    current: shareableSessionIntentSchema.nullable(),
    history: z.array(shareableSessionIntentSchema),
  })
  .strict();

export type ShareableSessionIntentBundle = z.infer<
  typeof shareableSessionIntentBundleSchema
>;

export const sessionIntentSetCommandSchema = z
  .object({
    kind: z.literal("set"),
    scope: exactTabScopeSchema,
    expectedPage: expectedTabPageSchema,
    body: z.string().trim().min(1).max(100_000),
    provenance: sessionIntentProvenanceSchema,
    visibility: contextVisibilitySchema,
    staleAt: z.string().datetime().nullable().optional(),
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const sessionIntentArchiveCommandSchema = z
  .object({
    kind: z.literal("archive"),
    intentId: z.number().int().positive(),
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const sessionIntentPromoteCommandSchema = z
  .object({
    kind: z.literal("promote"),
    intentId: z.number().int().positive(),
    subject: contextPageSubjectSchema,
    contextKind: contextEntryKindSchema,
    idempotencyKey: contextIdempotencyKeySchema,
  })
  .strict();

export const sessionIntentExpireDueCommandSchema = z
  .object({
    kind: z.literal("expire_due"),
    now: z.string().datetime(),
  })
  .strict();

export const sessionIntentCommandSchema = z.discriminatedUnion("kind", [
  sessionIntentSetCommandSchema,
  sessionIntentArchiveCommandSchema,
  sessionIntentPromoteCommandSchema,
  sessionIntentExpireDueCommandSchema,
]);

export type SessionIntentCommand = z.infer<typeof sessionIntentCommandSchema>;

export const localSessionIntentCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set"),
      scope: exactTabScopeSchema,
      expectedUrl: tabUrlSchema,
      body: z.string().trim().min(1).max(100_000),
      visibility: contextVisibilitySchema,
      staleAt: z.string().datetime().nullable().optional(),
      idempotencyKey: contextIdempotencyKeySchema,
    })
    .strict(),
  sessionIntentArchiveCommandSchema
    .extend({
      scope: exactTabScopeSchema,
      expectedPage: expectedTabPageSchema,
    })
    .strict(),
  sessionIntentPromoteCommandSchema
    .omit({ subject: true })
    .extend({
      scope: exactTabScopeSchema,
      expectedPage: expectedTabPageSchema,
    })
    .strict(),
]);

export type LocalSessionIntentCommand = z.infer<
  typeof localSessionIntentCommandSchema
>;

export const exactTabScopeQuerySchema = z
  .object({
    installationId: installationIdSchema,
    browserSessionId: browserSessionIdSchema,
    browserTabId: z.coerce.number().int().nonnegative(),
  })
  .strict();

export const agentSessionIntentSetCommandSchema = sessionIntentSetCommandSchema
  .omit({ provenance: true, visibility: true, expectedPage: true })
  .extend({
    expectedUrl: tabUrlSchema,
    provenance: z.union([
      z.object({ method: z.literal("on_behalf_of_user") }).strict(),
      z
        .object({
          method: z.literal("model"),
          sourceFingerprint: contextSourceFingerprintSchema,
          model: modelProvenanceSchema,
          confidence: z.number().finite().min(0).max(1).optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export type AgentSessionIntentSetCommand = z.infer<
  typeof agentSessionIntentSetCommandSchema
>;

export const contextSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(4_096),
    logicalPageId: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

export const logicalPageParamSchema = z
  .object({ logicalPageId: z.coerce.number().int().positive() })
  .strict();

export const localPairingChallengeRequestSchema = z
  .object({
    installationId: installationIdSchema,
    extensionOrigin: extensionOriginSchema,
  })
  .strict();

export const localPairingChallengeResponseSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().min(40).max(128),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const localPairingConsumeRequestSchema = z
  .object({
    challengeId: z.string().uuid(),
    installationId: installationIdSchema,
    code: z.string().min(40).max(128),
  })
  .strict();

export const localCredentialResponseSchema = z
  .object({
    credential: z.string().min(40).max(128),
    credentialVersion: z.number().int().positive(),
  })
  .strict();

export const localCapabilityInstallationParamSchema = z
  .object({ installationId: installationIdSchema })
  .strict();

export const localCapabilityRotateRequestSchema = z
  .object({ extensionOrigin: extensionOriginSchema })
  .strict();

export const sessionIntentChangeResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), intent: sessionIntentSchema }).strict(),
  z.object({ kind: z.literal("archived"), intent: sessionIntentSchema }).strict(),
  z
    .object({
      kind: z.literal("promoted"),
      intent: sessionIntentSchema,
      context: contextEntrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("expired"),
      intentIds: z.array(z.number().int().positive()),
    })
    .strict(),
]);

export type SessionIntentChangeResult = z.infer<
  typeof sessionIntentChangeResultSchema
>;

export const sessionIntentQuerySchema = z
  .object({
    logicalPageId: z.coerce.number().int().positive().optional(),
    state: sessionIntentStateSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

export type SessionIntentQuery = z.infer<typeof sessionIntentQuerySchema>;

export const sessionIntentPageSchema = z
  .object({
    items: z.array(sessionIntentSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();

export type SessionIntentPage = z.infer<typeof sessionIntentPageSchema>;

export const legacyImportanceReviewQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type LegacyImportanceReviewQuery = z.infer<
  typeof legacyImportanceReviewQuerySchema
>;

export const legacyImportanceReviewResponseSchema = z.object({
  items: z.array(logicalPageViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type LegacyImportanceReviewResponse = z.infer<
  typeof legacyImportanceReviewResponseSchema
>;

export const tabIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type TabIdParam = z.infer<typeof tabIdParamSchema>;

export const assignedBySchema = z.enum(["user", "agent"]);

export type AssignedBy = z.infer<typeof assignedBySchema>;

export const tagPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((path) =>
    path
      .split("/")
      .map((segment) => segment.trim())
      .join("/"),
  )
  .superRefine((path, context) => {
    const segments = path.split("/");

    if (segments.length > 32) {
      context.addIssue({
        code: "custom",
        message: "Tag paths cannot be deeper than 32 segments",
      });
    }

    if (segments.some((segment) => segment.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Tag path segments cannot be empty",
      });
    }

    if (segments.some((segment) => segment.length > 128)) {
      context.addIssue({
        code: "custom",
        message: "Tag path segments cannot exceed 128 characters",
      });
    }
  });

export type TagPath = z.infer<typeof tagPathSchema>;

export const patchTabStatusSchema = z.object({
  status: tabStatusSchema,
});

export type PatchTabStatus = z.infer<typeof patchTabStatusSchema>;

export const patchTabStatusResponseSchema = z.object({
  id: tabIdSchema,
  status: tabStatusSchema,
});

export type PatchTabStatusResponse = z.infer<
  typeof patchTabStatusResponseSchema
>;

const customFieldKeyInputSchema = z.string().trim().min(1).max(256);
const customFieldValueInputSchema = z.string().max(100_000).nullable();

const patchCustomFieldsSchema = z
  .record(customFieldKeyInputSchema, customFieldValueInputSchema)
  .refine(
    (fields) => Object.keys(fields).length > 0,
    "At least one custom field is required",
  )
  .refine(
    (fields) => Object.keys(fields).length <= 100,
    "At most 100 custom fields can be changed at once",
  );

export const patchTabSchema = z
  .object({
    status: tabStatusSchema.optional(),
    importance: tabImportanceSchema.optional(),
    customFields: patchCustomFieldsSchema.optional(),
  })
  .refine(
    (input) =>
      input.status !== undefined ||
      input.importance !== undefined ||
      input.customFields !== undefined,
    "At least one tab field is required",
  );

export type PatchTab = z.infer<typeof patchTabSchema>;

export const tabIdsSchema = z
  .array(tabIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique");

export type TabIds = z.infer<typeof tabIdsSchema>;

export const setStatusSchema = z.object({
  ids: tabIdsSchema,
  status: tabStatusSchema,
});

export type SetStatus = z.infer<typeof setStatusSchema>;

export const setStatusResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  status: tabStatusSchema,
});

export type SetStatusResponse = z.infer<typeof setStatusResponseSchema>;

export const setImportanceSchema = z.object({
  ids: tabIdsSchema,
  importance: tabImportanceSchema,
});

export type SetImportance = z.infer<typeof setImportanceSchema>;

export const setImportanceResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  importance: tabImportanceSchema,
});

export type SetImportanceResponse = z.infer<
  typeof setImportanceResponseSchema
>;

export const tagIdSchema = z.number().int().positive();

export const tagIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type TagIdParam = z.infer<typeof tagIdParamSchema>;

const tagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((name) => !name.includes("/"), "Tag names cannot contain slashes");
const tagColorInputSchema = z.string().max(128).nullable();

export const createTagSchema = z.object({
  name: tagNameInputSchema,
  parentId: tagIdSchema.optional(),
  color: tagColorInputSchema.optional(),
});

export type CreateTag = z.infer<typeof createTagSchema>;

export const patchTagSchema = z
  .object({
    name: tagNameInputSchema.optional(),
    parentId: tagIdSchema.nullable().optional(),
    color: tagColorInputSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.parentId !== undefined ||
      input.color !== undefined,
    "At least one tag field is required",
  );

export type PatchTag = z.infer<typeof patchTagSchema>;

export const tagRecordSchema = z.object({
  id: tagIdSchema,
  name: z.string(),
  parentId: tagIdSchema.nullable(),
  color: z.string().nullable(),
});

export type TagRecord = z.infer<typeof tagRecordSchema>;

export const tabTagIdsParamSchema = z.object({
  tabId: z.coerce.number().int().positive(),
  tagId: z.coerce.number().int().positive(),
});

export type TabTagIdsParam = z.infer<typeof tabTagIdsParamSchema>;

export const assignTagsSchema = z.object({
  ids: tabIdsSchema,
  tagPath: tagPathSchema,
  assignedBy: assignedBySchema,
});

export type AssignTags = z.infer<typeof assignTagsSchema>;

export const assignTagsResponseSchema = z.object({
  tagId: tabIdSchema,
  assigned: z.number().int().nonnegative(),
});

export type AssignTagsResponse = z.infer<typeof assignTagsResponseSchema>;

export const tabListItemSchema = z.object({
  id: z.number().int().positive(),
  logicalPageId: logicalPageIdSchema,
  url: z.string().trim().min(1),
  urlNormalized: z.string().trim().min(1),
  title: z.string().nullable(),
  browser: browserIdentifierSchema,
  windowId: z.number().int().nullable(),
  index: z.number().int().nonnegative().nullable(),
  faviconUrl: z.string().nullable(),
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  isOpen: z.boolean(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  summary: z.string().nullable(),
  tagPaths: z.array(z.string()),
  foregroundTimeMs: z.number().int().nonnegative().default(0),
  engagedTimeMs: z.number().int().nonnegative().default(0),
  openInstanceCount: z.number().int().nonnegative().default(0),
  openForegroundTimeMs: z.number().int().nonnegative().default(0),
  openEngagedTimeMs: z.number().int().nonnegative().default(0),
});

export type TabListItem = z.infer<typeof tabListItemSchema>;

export const localTabListItemSchema = tabListItemSchema.extend({
  contextPreview: contextPreviewSchema.nullable(),
});

export type LocalTabListItem = z.infer<typeof localTabListItemSchema>;

export const retentionReasonSchema = z.enum([
  "closed",
  "search_results",
  "no_captured_content",
  "no_engaged_activity",
  "no_custom_fields",
  "no_links",
]);

export type RetentionReason = z.infer<typeof retentionReasonSchema>;

export const retentionWarningSchema = z.object({
  kind: z.enum([
    "open_instances",
    "pinned",
    "workspace",
    "links",
    "captured_content",
  ]),
  count: z.number().int().positive(),
});

export type RetentionWarning = z.infer<typeof retentionWarningSchema>;

export const retentionCandidateSchema = z.object({
  tab: tabListItemSchema,
  score: z.number().min(0).max(1),
  reasons: z.array(retentionReasonSchema).min(1),
  warnings: z.array(retentionWarningSchema),
});

export type RetentionCandidate = z.infer<typeof retentionCandidateSchema>;

export const retentionDecisionSchema = z.enum(["keep", "later", "trash"]);

export type RetentionDecision = z.infer<typeof retentionDecisionSchema>;

export const retentionStateSchema = z.enum(["kept", "deferred", "trashed"]);

export type RetentionState = z.infer<typeof retentionStateSchema>;

export const setRetentionDecisionSchema = z
  .object({
    decision: retentionDecisionSchema,
    decidedBy: assignedBySchema,
    confirmed: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.decision === "trash" && input.confirmed !== true) {
      context.addIssue({
        code: "custom",
        message: "Trash decisions require explicit confirmation",
        path: ["confirmed"],
      });
    }
  });

export type SetRetentionDecision = z.infer<
  typeof setRetentionDecisionSchema
>;

export const retentionDecisionResponseSchema = z.object({
  tabId: tabIdSchema,
  decision: retentionDecisionSchema,
  state: retentionStateSchema,
  decidedBy: assignedBySchema,
  decidedAt: z.string().datetime(),
  reviewAfter: z.string().datetime().nullable(),
  trashedAt: z.string().datetime().nullable(),
  purgeAt: z.string().datetime().nullable(),
});

export type RetentionDecisionResponse = z.infer<
  typeof retentionDecisionResponseSchema
>;

export const restoreRetentionSchema = z.object({
  decidedBy: assignedBySchema,
});

export type RestoreRetention = z.infer<typeof restoreRetentionSchema>;

export const forgetRetentionSchema = z.object({
  decidedBy: assignedBySchema,
  confirmed: z.literal(true),
});

export type ForgetRetention = z.infer<typeof forgetRetentionSchema>;

export const retentionForgetResponseSchema = z.object({
  tabId: tabIdSchema,
  outcome: z.enum(["trashed", "blocked"]),
  reason: z
    .enum([
      "scope_offline",
      "outcome_unknown",
      "unaddressable_instance",
      "preview_changed",
      "close_incomplete",
      "instances_remain",
    ])
    .nullable(),
  closedInstanceCount: z.number().int().nonnegative(),
  purgeAt: z.string().datetime().nullable(),
});

export type RetentionForgetResponse = z.infer<
  typeof retentionForgetResponseSchema
>;

export const retentionTrashItemSchema = z.object({
  tab: tabListItemSchema,
  decidedBy: assignedBySchema,
  trashedAt: z.string().datetime(),
  purgeAt: z.string().datetime(),
});

export type RetentionTrashItem = z.infer<typeof retentionTrashItemSchema>;

export const tabInstanceSchema = z.object({
  instanceId: z.number().int().positive(),
  canonicalTabId: tabIdSchema,
  installationId: z.string().min(1),
  browserSessionId: browserSessionIdSchema.nullable().default(null),
  browserTabId: z.number().int().nonnegative().nullable(),
  instanceRevision: z.number().int().positive(),
  url: z.string().trim().min(1),
  urlNormalized: z.string().trim().min(1),
  title: z.string().nullable(),
  browser: browserIdentifierSchema,
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().nullable(),
  active: z.boolean(),
  audible: z.boolean(),
  muted: z.boolean(),
  discarded: z.boolean(),
  pinned: z.boolean(),
  lastAccessed: z.number().finite().nonnegative().nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  foregroundTimeMs: z.number().int().nonnegative().default(0),
  engagedTimeMs: z.number().int().nonnegative().default(0),
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  summary: z.string().nullable(),
  tagPaths: z.array(z.string()),
  duplicateGroupSize: z.number().int().positive(),
});

export type TabInstance = z.infer<typeof tabInstanceSchema>;

export const workspaceSelectionSchema = z.strictObject({
  instanceId: z.number().int().positive(),
  browser: browserIdentifierSchema,
  installationId: z.string().trim().min(1).max(256),
  browserSessionId: browserSessionIdSchema.nullable(),
  browserTabId: z.number().int().nonnegative().nullable(),
});

export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

const workspaceNameSchema = z.string().trim().min(1).max(200);

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  selections: z
    .array(workspaceSelectionSchema)
    .min(1)
    .refine(
      (selections) =>
        new Set(selections.map(({ instanceId }) => instanceId)).size ===
        selections.length,
      "Workspace selections must use unique instance IDs",
    ),
});

export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;

export const patchWorkspaceSchema = z.object({
  name: workspaceNameSchema,
});

export type PatchWorkspace = z.infer<typeof patchWorkspaceSchema>;

export const workspaceIdSchema = z.number().int().positive();

export const workspaceIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type WorkspaceIdParam = z.infer<typeof workspaceIdParamSchema>;

export const workspaceItemSchema = z.object({
  id: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  sourceInstanceId: z.number().int().positive(),
  canonicalTabId: tabIdSchema.nullable(),
  browser: browserIdentifierSchema,
  installationId: z.string().trim().min(1),
  browserSessionId: browserSessionIdSchema.nullable(),
  browserTabId: z.number().int().nonnegative().nullable(),
  url: tabUrlSchema,
  title: z.string().nullable(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().nullable(),
  active: z.boolean(),
  pinned: z.boolean(),
  audible: z.boolean(),
  muted: z.boolean(),
  discarded: z.boolean(),
  lastAccessed: z.number().finite().nonnegative().nullable(),
});

export type WorkspaceItem = z.infer<typeof workspaceItemSchema>;

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceDetailSchema = workspaceSummarySchema.extend({
  items: z.array(workspaceItemSchema),
});

export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const workspaceListResponseSchema = z.object({
  items: z.array(workspaceSummarySchema),
});

export type WorkspaceListResponse = z.infer<
  typeof workspaceListResponseSchema
>;

const persistedTagNameSchema = z.string();
const persistedTagPathSchema = z.string();
const tagColorSchema = z.string().nullable();

export const tabTagSchema = z.object({
  id: tabIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  color: tagColorSchema,
  assignedBy: assignedBySchema,
});

export type TabTag = z.infer<typeof tabTagSchema>;

export const tabLinkSchema = z.object({
  id: tabIdSchema,
  fromTab: tabIdSchema,
  toTab: tabIdSchema,
  kind: z.string(),
  note: z.string().nullable(),
  createdBy: assignedBySchema,
});

export type TabLink = z.infer<typeof tabLinkSchema>;

export const graphQuerySchema = z.object({
  root_tag: tagPathSchema.optional(),
});

export type GraphQuery = z.infer<typeof graphQuerySchema>;

export const graphNodeSchema = z.object({
  id: tabIdSchema,
  title: z.string().nullable(),
  url: z.string(),
  browser: browserIdentifierSchema,
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  isOpen: z.boolean(),
  tagPaths: z.array(z.string()),
  rootTags: z.array(z.string()),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphResponseSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(tabLinkSchema),
});

export type GraphResponse = z.infer<typeof graphResponseSchema>;

const linkKindInputSchema = z.string().trim().min(1).max(128);
const linkNoteInputSchema = z.string().max(10_000).nullable();

export const linkIdSchema = z.number().int().positive();

export const linkIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type LinkIdParam = z.infer<typeof linkIdParamSchema>;

export const linkListQuerySchema = z.object({
  tab_id: z.coerce.number().int().positive().optional(),
});

export type LinkListQuery = z.infer<typeof linkListQuerySchema>;

export const linkListResponseSchema = z.object({
  items: z.array(tabLinkSchema),
});

export type LinkListResponse = z.infer<typeof linkListResponseSchema>;

export const createLinkSchema = z.object({
  from: tabIdSchema,
  to: tabIdSchema,
  kind: linkKindInputSchema.default("related"),
  note: linkNoteInputSchema.optional(),
  createdBy: assignedBySchema,
});

export type CreateLink = z.infer<typeof createLinkSchema>;

export const patchLinkSchema = z
  .object({
    kind: linkKindInputSchema.optional(),
    note: linkNoteInputSchema.optional(),
  })
  .refine(
    (input) => input.kind !== undefined || input.note !== undefined,
    "At least one link field is required",
  );

export type PatchLink = z.infer<typeof patchLinkSchema>;

export const knowledgeNodeTypeSchema = z.enum(["tab", "topic"]);

export type KnowledgeNodeType = z.infer<typeof knowledgeNodeTypeSchema>;

export const knowledgeNodeRefSchema = z.object({
  type: knowledgeNodeTypeSchema,
  id: z.number().int().positive(),
});

export type KnowledgeNodeRef = z.infer<typeof knowledgeNodeRefSchema>;

export const relationIdSchema = z.number().int().positive();

export const relationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type RelationIdParam = z.infer<typeof relationIdParamSchema>;

export const knowledgeRelationSchema = z.object({
  id: relationIdSchema,
  from: knowledgeNodeRefSchema,
  to: knowledgeNodeRefSchema,
  kind: z.string(),
  note: z.string().nullable(),
  createdBy: assignedBySchema,
});

export type KnowledgeRelation = z.infer<typeof knowledgeRelationSchema>;

export const createKnowledgeRelationSchema = z.object({
  from: knowledgeNodeRefSchema,
  to: knowledgeNodeRefSchema,
  kind: linkKindInputSchema.default("related"),
  note: linkNoteInputSchema.optional(),
  createdBy: assignedBySchema,
});

export type CreateKnowledgeRelation = z.infer<
  typeof createKnowledgeRelationSchema
>;

export const patchKnowledgeRelationSchema = patchLinkSchema;

export type PatchKnowledgeRelation = z.infer<
  typeof patchKnowledgeRelationSchema
>;

export const relationListQuerySchema = z
  .object({
    node_type: knowledgeNodeTypeSchema.optional(),
    node_id: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (query) =>
      (query.node_type === undefined) === (query.node_id === undefined),
    "node_type and node_id must be provided together",
  );

export type RelationListQuery = z.infer<typeof relationListQuerySchema>;

export const knowledgeRelationListResponseSchema = z.object({
  items: z.array(knowledgeRelationSchema),
});

export type KnowledgeRelationListResponse = z.infer<
  typeof knowledgeRelationListResponseSchema
>;

export const graphV2QuerySchema = z
  .object({
    root_topic_id: z.coerce.number().int().positive().optional(),
    focus_node_type: knowledgeNodeTypeSchema.optional(),
    focus_node_id: z.coerce.number().int().positive().optional(),
    focus_depth: z.coerce.number().int().min(1).max(5).optional(),
  })
  .refine(
    (query) => {
      const focusFields = [
        query.focus_node_type,
        query.focus_node_id,
        query.focus_depth,
      ];
      const providedCount = focusFields.filter(
        (value) => value !== undefined,
      ).length;
      return providedCount === 0 || providedCount === focusFields.length;
    },
    "focus_node_type, focus_node_id, and focus_depth must be provided together",
  );

export type GraphV2Query = z.infer<typeof graphV2QuerySchema>;

export const graphV2TabNodeSchema = graphNodeSchema.extend({
  type: z.literal("tab"),
});

export type GraphV2TabNode = z.infer<typeof graphV2TabNodeSchema>;

export const graphV2TopicNodeSchema = z.object({
  type: z.literal("topic"),
  id: tagIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  parentId: tagIdSchema.nullable(),
  color: tagColorSchema,
  directTabCount: z.number().int().nonnegative(),
  tabCount: z.number().int().nonnegative(),
});

export type GraphV2TopicNode = z.infer<typeof graphV2TopicNodeSchema>;

export const graphV2NodeSchema = z.discriminatedUnion("type", [
  graphV2TabNodeSchema,
  graphV2TopicNodeSchema,
]);

export type GraphV2Node = z.infer<typeof graphV2NodeSchema>;

export const graphV2EdgeTypeSchema = z.enum([
  "containment",
  "membership",
  "relation",
]);

export type GraphV2EdgeType = z.infer<typeof graphV2EdgeTypeSchema>;

export const graphV2EdgeSchema = z.object({
  id: z.string().min(1),
  edgeType: graphV2EdgeTypeSchema,
  source: knowledgeNodeRefSchema,
  target: knowledgeNodeRefSchema,
  relationId: relationIdSchema.nullable(),
  relationKind: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: assignedBySchema.nullable(),
});

export type GraphV2Edge = z.infer<typeof graphV2EdgeSchema>;

export const graphV2ResponseSchema = z.object({
  nodes: z.array(graphV2NodeSchema),
  edges: z.array(graphV2EdgeSchema),
});

export type GraphV2Response = z.infer<typeof graphV2ResponseSchema>;

export const deleteResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

export const customFieldsSchema = z.record(z.string(), z.string().nullable());

export type CustomFields = z.infer<typeof customFieldsSchema>;

export const tabContentSchema = z.object({
  text: ingestContentSchema.shape.text.nullable(),
  htmlExcerpt: ingestContentSchema.shape.htmlExcerpt.nullable(),
  // Current servers always emit this; optional parsing keeps rolling clients
  // able to read a pre-C70 response while W71 requires it before enqueue.
  contentRevision: z.number().int().positive().optional(),
  summary: z.string().nullable(),
  summaryModel: z.string().nullable(),
  extractedAt: z.string().datetime().nullable(),
});

export type TabContent = z.infer<typeof tabContentSchema>;

export const tabDetailResponseSchema = tabListItemSchema.extend({
  content: tabContentSchema.nullable(),
  tags: z.array(tabTagSchema),
  links: z.array(tabLinkSchema),
  customFields: customFieldsSchema,
});

export type TabDetailResponse = z.infer<typeof tabDetailResponseSchema>;

export const summaryDepthSchema = z.enum(["short", "deep"]);

export type SummaryDepth = z.infer<typeof summaryDepthSchema>;

export const summarizeTabSchema = z.object({
  depth: summaryDepthSchema,
  expectedContentRevision: z.number().int().positive().optional(),
  requestedBy: assignedBySchema.default("user"),
});

export type SummarizeTab = z.infer<typeof summarizeTabSchema>;

export const summaryContentRevisionMismatchErrorSchema = z
  .object({
    error: z.literal("TAB_CONTENT_REVISION_MISMATCH"),
    message: z.string().min(1),
    expectedContentRevision: z.number().int().positive(),
    currentContentRevision: z.number().int().positive().nullable(),
  })
  .strict();

export type SummaryContentRevisionMismatchError = z.infer<
  typeof summaryContentRevisionMismatchErrorSchema
>;

export const summaryJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export type SummaryJobStatus = z.infer<typeof summaryJobStatusSchema>;

export const summaryUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
});

export type SummaryUsage = z.infer<typeof summaryUsageSchema>;

export const summaryJobResultSchema = z.object({
  summary: z.string(),
  model: z.string(),
  usage: summaryUsageSchema,
});

export type SummaryJobResult = z.infer<typeof summaryJobResultSchema>;

export const jobIdSchema = z.number().int().positive();

export const jobIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type JobIdParam = z.infer<typeof jobIdParamSchema>;

export const summaryEnqueueResponseSchema = z.object({
  jobId: jobIdSchema,
  // Present on every current server response. Optional parsing keeps older
  // adapters readable during the rolling protocol upgrade; the capture flow
  // fails closed when it is absent.
  sourceContentRevision: z.number().int().positive().optional(),
  status: summaryJobStatusSchema,
});

export type SummaryEnqueueResponse = z.infer<
  typeof summaryEnqueueResponseSchema
>;

export const summaryJobSchema = z.object({
  id: jobIdSchema,
  tabId: tabIdSchema,
  // Current servers always emit these fields. Optional parsing preserves old
  // persisted/adapter fixtures while new UI orchestration requires all three.
  sourceContentRevision: z.number().int().positive().optional(),
  currentContentRevision: z.number().int().positive().nullable().optional(),
  contentRevisionMatches: z.boolean().optional(),
  depth: summaryDepthSchema,
  status: summaryJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  result: summaryJobResultSchema.nullable(),
});

export type SummaryJob = z.infer<typeof summaryJobSchema>;

export type CurrentSummaryJob = SummaryJob & {
  status: "succeeded";
  contentRevisionMatches: true;
  result: SummaryJobResult;
};

export function hasCurrentSummaryResult(
  job: SummaryJob,
): job is CurrentSummaryJob {
  return (
    job.status === "succeeded" &&
    job.contentRevisionMatches === true &&
    job.result !== null
  );
}

const durablePositiveSafeIntegerSchema = z.number().int().positive()
  .max(Number.MAX_SAFE_INTEGER);
const durableNonnegativeSafeIntegerSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const durableBoundedTextSchema = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim())
  .refine((value) => {
    const bytes = new TextEncoder().encode(value).byteLength;
    return bytes >= 1 && bytes <= maximum;
  });

export const durableFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const durableJobIdSchema = z.string().superRefine((value, context) => {
  const match = /^(summary|priority_assessment|resource_research):([1-9][0-9]*)$/
    .exec(value);
  if (match === null) {
    context.addIssue({ code: "custom", message: "Invalid durable job ID" });
    return;
  }
  const suffix = Number(match[2]);
  if (!Number.isSafeInteger(suffix)) {
    context.addIssue({ code: "custom", message: "Durable job ID is not safe" });
  }
});

export type DurableJobId = z.infer<typeof durableJobIdSchema>;

export const aiJobProvenanceSchema = z.discriminatedUnion("requestedBy", [
  z.object({
    requestedBy: z.literal("user"),
    requestMethod: z.literal("manual"),
  }).strict(),
  z.object({
    requestedBy: z.literal("agent"),
    requestMethod: z.literal("on_behalf_of_user"),
    authorizationRef: durableBoundedTextSchema(256),
  }).strict(),
  z.object({
    requestedBy: z.literal("system"),
    requestMethod: z.literal("scheduled"),
  }).strict(),
]);

export type AiJobProvenance = z.infer<typeof aiJobProvenanceSchema>;

export const aiJobBudgetSchema = z.object({
  maxSteps: durablePositiveSafeIntegerSchema,
  maxTokens: durableNonnegativeSafeIntegerSchema,
  maxCostUsd: z.number().finite().nonnegative().max(1e308),
  maxWallTimeMs: durablePositiveSafeIntegerSchema,
}).strict();

export type AiJobBudget = z.infer<typeof aiJobBudgetSchema>;

export const aiJobPageSubjectSchema = z.object({
  type: z.literal("page"),
  logicalPageId: durablePositiveSafeIntegerSchema,
}).strict();

export const aiJobResourceSubjectSchema = z.object({
  type: z.literal("resource"),
  resourceId: durablePositiveSafeIntegerSchema,
}).strict();

export const aiJobCollectionSubjectSchema = z.object({
  type: z.literal("collection"),
  scope: z.literal("all"),
}).strict();

export const aiJobSelectionSubjectSchema = z.object({
  type: z.literal("selection"),
  fingerprint: durableFingerprintSchema,
}).strict();

export const aiJobPrioritySubjectSchema = z.discriminatedUnion("type", [
  aiJobPageSubjectSchema,
  aiJobResourceSubjectSchema,
  aiJobCollectionSubjectSchema,
]);

export const aiJobResearchSubjectSchema = z.discriminatedUnion("type", [
  aiJobPageSubjectSchema,
  aiJobResourceSubjectSchema,
  aiJobSelectionSubjectSchema,
]);

export const aiJobWorkflowRefSchema = z.object({
  id: durableBoundedTextSchema(128),
  version: durablePositiveSafeIntegerSchema,
}).strict();

export const aiJobRulesetRefSchema = z.object({
  rulesetId: durablePositiveSafeIntegerSchema,
  version: durablePositiveSafeIntegerSchema,
}).strict();

export const aiJobAssessmentProvenanceSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("rule") }).strict(),
  z.object({
    method: z.literal("model"),
    model: z.object({
      provider: durableBoundedTextSchema(128),
      name: durableBoundedTextSchema(128),
      promptVersion: durableBoundedTextSchema(128),
    }).strict(),
  }).strict(),
]);

export const pageSummaryTaskSpecSchema = z.object({
  version: z.literal(1),
  kind: z.literal("page_summary"),
  subject: z.object({
    type: z.literal("tab"),
    tabId: durablePositiveSafeIntegerSchema,
  }).strict(),
  depth: summaryDepthSchema,
  requestedBy: z.enum(["user", "agent"]),
  requestedModel: durableBoundedTextSchema(200),
  maxAttempts: durablePositiveSafeIntegerSchema,
}).strict();

export const priorityAssessmentTaskSpecSchema = z.object({
  version: z.literal(1),
  kind: z.literal("priority_assessment"),
  subject: aiJobPrioritySubjectSchema,
  ruleset: aiJobRulesetRefSchema,
  assessmentProvenance: aiJobAssessmentProvenanceSchema,
  inputFingerprint: durableFingerprintSchema,
  idempotencyKey: durableBoundedTextSchema(200),
  stepBatchSize: z.number().int().min(1).max(100),
  provenance: aiJobProvenanceSchema,
  schedulingPriority: z.number().int().min(-100).max(100),
  budget: aiJobBudgetSchema,
}).strict();

export const resourceResearchTaskSpecSchema = z.object({
  version: z.literal(1),
  kind: z.literal("resource_research"),
  subject: aiJobResearchSubjectSchema,
  workflowRef: aiJobWorkflowRefSchema,
  inputFingerprint: durableFingerprintSchema,
  idempotencyKey: durableBoundedTextSchema(200),
  provenance: aiJobProvenanceSchema,
  schedulingPriority: z.number().int().min(-100).max(100),
  budget: aiJobBudgetSchema,
}).strict();

export const aiTaskSpecSchema = z.discriminatedUnion("kind", [
  pageSummaryTaskSpecSchema,
  priorityAssessmentTaskSpecSchema,
  resourceResearchTaskSpecSchema,
]);

export type AiTaskSpec = z.infer<typeof aiTaskSpecSchema>;
export type PageSummaryTaskSpec = z.infer<typeof pageSummaryTaskSpecSchema>;
export type PriorityAssessmentTaskSpec = z.infer<
  typeof priorityAssessmentTaskSpecSchema
>;
export type ResourceResearchTaskSpec = z.infer<
  typeof resourceResearchTaskSpecSchema
>;

export const durableJobKindSchema = z.enum([
  "page_summary",
  "priority_assessment",
  "resource_research",
]);

export type DurableJobKind = z.infer<typeof durableJobKindSchema>;

export const durableJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "superseded",
]);

export type DurableJobStatus = z.infer<typeof durableJobStatusSchema>;

export const durableJobErrorCodeSchema = z.enum([
  "INVALID_JOB_INPUT",
  "JOB_SUBJECT_NOT_FOUND",
  "JOB_INPUT_UNAVAILABLE",
  "JOB_BUDGET_EXHAUSTED",
  "JOB_LEASE_LOST",
  "JOB_CLOCK_REGRESSION",
  "INVALID_JOB_TRANSITION",
  "JOB_STORAGE_CORRUPT",
  "RESEARCH_SCOPE_TOO_LARGE",
  "RESEARCH_PREFLIGHT_STALE",
]);

export const durableJobFailureSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("durable"),
    code: durableJobErrorCodeSchema,
    message: durableBoundedTextSchema(1024),
  }).strict(),
  z.object({
    type: z.literal("legacy_summary"),
    message: durableBoundedTextSchema(8192),
  }).strict(),
]);

const durableTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  });

export const durableJobSubjectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tab"),
    tabId: durablePositiveSafeIntegerSchema,
  }).strict(),
  aiJobPageSubjectSchema,
  aiJobResourceSubjectSchema,
  aiJobCollectionSubjectSchema,
  aiJobSelectionSubjectSchema,
]);

export const durableJobProgressSchema = z.object({
  completed: durableNonnegativeSafeIntegerSchema,
  total: durableNonnegativeSafeIntegerSchema.nullable(),
  stage: durableBoundedTextSchema(128),
}).strict().refine(
  (value) => value.total === null || value.completed <= value.total,
  { message: "Completed progress cannot exceed total" },
);

export const durableCancellationRequestSchema = z.object({
  requestedBy: z.enum(["user", "agent"]),
  requestedAt: durableTimestampSchema,
}).strict();

export const durableJobResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page_summary"),
    value: summaryJobResultSchema,
  }).strict(),
  z.object({
    type: z.literal("priority_assessment"),
    outputFingerprint: durableFingerprintSchema,
  }).strict(),
  z.object({
    type: z.literal("resource_research"),
    reportId: durablePositiveSafeIntegerSchema,
  }).strict(),
]);

export const durableJobRefSchema = z.object({
  id: durableJobIdSchema,
  kind: durableJobKindSchema,
  status: durableJobStatusSchema,
}).strict().superRefine((value, context) => {
  const expectedPrefix = value.kind === "page_summary" ? "summary" : value.kind;
  if (!value.id.startsWith(`${expectedPrefix}:`)) {
    context.addIssue({ code: "custom", message: "Job ID kind mismatch" });
  }
  if (value.kind === "page_summary" &&
      !["queued", "running", "succeeded", "failed"].includes(value.status)) {
    context.addIssue({ code: "custom", message: "Invalid legacy summary status" });
  }
});

export type DurableJobRef = z.infer<typeof durableJobRefSchema>;

export const agentResearchStartResponseSchema = z.union([
  durableJobRefSchema.refine((value) => value.kind === "resource_research", {
    message: "Agent research start must return a resource research job",
  }),
  z.strictObject({
    status: z.literal("confirmation_required"),
    confirmationRequirements: researchOriginConfirmationRequirementsSchema,
  }),
]);

export type AgentResearchStartResponse = z.infer<
  typeof agentResearchStartResponseSchema
>;

export const durableJobViewSchema = z.object({
  id: durableJobIdSchema,
  kind: durableJobKindSchema,
  subject: durableJobSubjectSchema,
  status: durableJobStatusSchema,
  attempts: durableNonnegativeSafeIntegerSchema,
  maxAttempts: durablePositiveSafeIntegerSchema,
  progress: durableJobProgressSchema,
  canCancel: z.boolean(),
  cancellationRequest: durableCancellationRequestSchema.nullable(),
  createdAt: durableTimestampSchema,
  startedAt: durableTimestampSchema.nullable(),
  completedAt: durableTimestampSchema.nullable(),
  nextAttemptAt: durableTimestampSchema.nullable(),
  error: durableJobFailureSchema.nullable(),
  result: durableJobResultSchema.nullable(),
}).strict().superRefine((value, context) => {
  const expectedPrefix = value.kind === "page_summary" ? "summary" : value.kind;
  if (!value.id.startsWith(`${expectedPrefix}:`)) {
    context.addIssue({ code: "custom", message: "Job ID kind mismatch" });
  }
  const subjectMatches = value.kind === "page_summary"
    ? value.subject.type === "tab"
    : value.kind === "priority_assessment"
      ? ["page", "resource", "collection"].includes(value.subject.type)
      : ["page", "resource", "selection"].includes(value.subject.type);
  if (!subjectMatches) {
    context.addIssue({ code: "custom", message: "Job subject kind mismatch" });
  }
  if (value.kind === "page_summary" &&
      !["queued", "running", "succeeded", "failed"].includes(value.status)) {
    context.addIssue({ code: "custom", message: "Invalid legacy summary status" });
  }
  if (value.error !== null && (
    value.kind === "page_summary" && value.error.type !== "legacy_summary" ||
    value.kind !== "page_summary" && value.error.type !== "durable"
  )) {
    context.addIssue({ code: "custom", message: "Job error kind mismatch" });
  }
  if (value.cancellationRequest !== null && (
    value.kind === "page_summary" ||
    value.status !== "running" && value.status !== "cancelled"
  )) {
    context.addIssue({ code: "custom", message: "Invalid cancellation request" });
  }
  if (value.result !== null && value.result.type !== value.kind) {
    context.addIssue({ code: "custom", message: "Job result kind mismatch" });
  }
  const expectedCanCancel = (value.status === "queued" || value.status === "running")
    && value.cancellationRequest === null && value.kind !== "page_summary";
  if (value.canCancel !== expectedCanCancel) {
    context.addIssue({ code: "custom", message: "Invalid cancellation capability" });
  }
  const issue = (message: string, path: string) => context.addIssue({
    code: "custom",
    message,
    path: [path],
  });
  const active = value.status === "queued" || value.status === "running";
  const terminal = !active;
  if (value.attempts > value.maxAttempts) {
    issue("Attempts exceed configured maximum", "attempts");
  }
  if (value.kind !== "page_summary" &&
      ["running", "succeeded", "partial", "failed"].includes(value.status) &&
      value.attempts === 0) {
    issue("Job status requires an attempt", "attempts");
  }
  if ((value.attempts === 0) !== (value.startedAt === null)) {
    issue("Job attempt and start timestamp disagree", "startedAt");
  }
  if (active && value.completedAt !== null || terminal && value.completedAt === null) {
    issue("Invalid completed timestamp for job status", "completedAt");
  }
  if (value.status === "running" && value.startedAt === null) {
    issue("Running job requires a start timestamp", "startedAt");
  }
  if (value.status !== "queued" && value.nextAttemptAt !== null) {
    issue("Only queued jobs can have a next attempt", "nextAttemptAt");
  }
  if (value.status === "queued" && value.nextAttemptAt === null) {
    issue("Queued job requires a next attempt", "nextAttemptAt");
  }
  if (value.kind !== "page_summary" && terminal && value.startedAt === null &&
      value.status !== "cancelled" && value.status !== "superseded") {
    issue("Terminal durable job requires a start timestamp", "startedAt");
  }
  const ordered = [value.startedAt, value.completedAt, value.nextAttemptAt]
    .filter((timestamp): timestamp is string => timestamp !== null);
  if (ordered.some((timestamp) => timestamp < value.createdAt) ||
      value.startedAt !== null && value.completedAt !== null &&
        value.completedAt < value.startedAt) {
    issue("Job timestamps are out of order", "createdAt");
  }
  if (value.status === "succeeded" && (value.result === null || value.error !== null)) {
    issue("Succeeded job requires a result without an error", "result");
  }
  if (value.status === "partial" && (
    value.result === null || value.error?.type !== "durable" ||
      value.error.code !== "JOB_BUDGET_EXHAUSTED"
  )) {
    issue("Partial job requires a result and budget diagnostic", "error");
  }
  if (value.status === "failed" && (value.result !== null || value.error === null)) {
    issue("Failed job requires an error without a result", "error");
  }
  if ((value.status === "cancelled" || value.status === "superseded") &&
      (value.result !== null || value.error !== null)) {
    issue("Cancelled or superseded job cannot have output", "result");
  }
  if (active && value.result !== null) {
    issue("Active job cannot have a result", "result");
  }
  if (value.status === "running" && value.error !== null) {
    issue("Running job cannot have an error", "error");
  }
});

export type DurableJobView = z.infer<typeof durableJobViewSchema>;

export const prioritySubjectSchema = z.discriminatedUnion("type", [
  aiJobPageSubjectSchema,
  aiJobResourceSubjectSchema,
]);

export type PrioritySubjectContract = z.infer<typeof prioritySubjectSchema>;

export const priorityBandSchema = z.enum(["low", "medium", "high", "critical"]);
export const priorityExclusionReasonSchema = z.enum([
  "unsupported_url",
  "private_or_internal",
  "user_excluded",
  "policy_excluded",
  "insufficient_signals",
  "temporarily_unavailable",
]);

export const priorityRulesetRefContractSchema = z.object({
  rulesetId: durablePositiveSafeIntegerSchema,
  version: durablePositiveSafeIntegerSchema,
}).strict();

export type PriorityRulesetRefContract = z.infer<
  typeof priorityRulesetRefContractSchema
>;

export const personalPriorityCompilerVersion =
  "priority-rule-natural-language-v1" as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const personalPriorityNaturalLanguageGrammarV1 = deepFreeze({
  compilerVersion: personalPriorityCompilerVersion,
  limits: {
    maxPersonalRules: 92,
    maxSourceCodePoints: 4_000,
    maxSourceUtf8Bytes: 8_192,
  },
  locales: {
    en: {
      ruleTemplate: "<subject> when <condition> then <effect>",
      conjunction: " and ",
      examples: [
        "pages when is open equals true then score add 10",
      ],
    },
    ru: {
      ruleTemplate: "<субъект> когда <условие> тогда <эффект>",
      conjunction: " и ",
      examples: [
        "страницы когда открыта равно да тогда оценка плюс 10",
      ],
    },
  },
  subjects: [
    { value: "page", phrases: { en: "pages", ru: "страницы" } },
    { value: "resource", phrases: { en: "resources", ru: "ресурсы" } },
    { value: "both", phrases: { en: "both", ru: "все" } },
  ],
  signals: [
    { value: "has_shareable_next_action", kind: "boolean", phrases: { en: "has next action", ru: "есть следующий шаг" } },
    { value: "has_shareable_project_context", kind: "boolean", phrases: { en: "has project context", ru: "есть контекст проекта" } },
    { value: "has_current_project_membership", kind: "boolean", phrases: { en: "is in current project", ru: "в текущем проекте" } },
    { value: "is_pinned", kind: "boolean", phrases: { en: "is pinned", ru: "закреплена" } },
    { value: "is_open", kind: "boolean", phrases: { en: "is open", ru: "открыта" } },
    { value: "has_captured_content", kind: "boolean", phrases: { en: "has captured content", ru: "есть сохраненный контент" } },
    { value: "has_current_summary", kind: "boolean", phrases: { en: "has current summary", ru: "есть актуальное резюме" } },
    { value: "has_current_research_report", kind: "boolean", phrases: { en: "has current research report", ru: "есть актуальное исследование" } },
    { value: "relation_count", kind: "numeric", phrases: { en: "relation count", ru: "число связей" } },
    { value: "active_use_30d_ms", kind: "numeric", phrases: { en: "active use 30d", ru: "активное использование 30д" } },
    { value: "on_screen_30d_ms", kind: "numeric", phrases: { en: "on screen 30d", ru: "на экране 30д" } },
    { value: "age_days", kind: "numeric", phrases: { en: "age days", ru: "возраст дней" } },
    { value: "last_seen_days", kind: "numeric", phrases: { en: "last seen days", ru: "дней с просмотра" } },
    { value: "duplicate_physical_count", kind: "numeric", phrases: { en: "open copy count", ru: "число открытых копий" } },
    { value: "resource_page_count", kind: "numeric", phrases: { en: "resource page count", ru: "число страниц ресурса" } },
    { value: "resource_captured_page_count", kind: "numeric", phrases: { en: "resource captured page count", ru: "число сохраненных страниц ресурса" } },
    { value: "topic_paths", kind: "string_set", phrases: { en: "topic path", ru: "тема" } },
    { value: "workspace_names", kind: "string_set", phrases: { en: "workspace name", ru: "рабочее пространство" } },
    { value: "status", kind: "string_set", phrases: { en: "status", ru: "статус" } },
  ],
  effects: [
    { value: "scoreDelta", phrases: { en: "score add", ru: "оценка плюс" } },
    { value: "confidenceDelta", phrases: { en: "confidence add", ru: "уверенность плюс" } },
    { value: "scoreFloor", phrases: { en: "score floor", ru: "оценка минимум" } },
    { value: "scoreCap", phrases: { en: "score cap", ru: "оценка максимум" } },
    { value: "needsReview", phrases: { en: "review", ru: "проверка" } },
    { value: "exclusionReason", phrases: { en: "exclude", ru: "исключить" } },
  ],
} as const);

/**
 * The browser computes this fingerprint and the server recomputes it before accepting
 * the request, so both sides must canonicalize identically. They do it with the one
 * shared canonicalization; a private copy here diverged on `Date`, `NaN` and
 * `Infinity`, which is a request the server would reject for reasons nobody could see.
 */
export async function personalPriorityRequestFingerprint(
  payload: unknown,
): Promise<string> {
  // Copied into a plain ArrayBuffer-backed view: SubtleCrypto will not accept the
  // helper's wider Uint8Array<ArrayBufferLike> return type.
  const bytes = new Uint8Array(researchCanonicalSha256PayloadV1(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const personalPriorityBooleanSignalSchema = z.enum([
  "has_shareable_next_action",
  "has_shareable_project_context",
  "has_current_project_membership",
  "is_pinned",
  "is_open",
  "has_captured_content",
  "has_current_summary",
  "has_current_research_report",
]);
const personalPriorityNumericSignalSchema = z.enum([
  "relation_count",
  "active_use_30d_ms",
  "on_screen_30d_ms",
  "age_days",
  "last_seen_days",
  "duplicate_physical_count",
  "resource_page_count",
  "resource_captured_page_count",
]);
const personalPriorityStringSetSignalSchema = z.enum([
  "topic_paths",
  "workspace_names",
  "status",
]);

export const personalPriorityConditionSchema = z.union([
  z.object({
    signal: personalPriorityBooleanSignalSchema,
    operator: z.literal("eq"),
    value: z.boolean(),
  }).strict(),
  z.object({
    signal: personalPriorityNumericSignalSchema,
    operator: z.enum(["eq", "gte", "lte"]),
    value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    signal: personalPriorityStringSetSignalSchema,
    operator: z.literal("in"),
    value: z.array(durableBoundedTextSchema(256)).min(1).max(100),
  }).strict(),
]);

export const personalPriorityRuleEffectSchema = z.object({
  scoreDelta: z.number().int().min(-100).max(100).optional(),
  confidenceDelta: z.number().finite().min(-1).max(1).optional(),
  scoreFloor: z.number().int().min(0).max(100).optional(),
  scoreCap: z.number().int().min(0).max(100).optional(),
  needsReview: z.boolean().optional(),
  exclusionReason: z.enum(["user_excluded", "policy_excluded"]).optional(),
}).strict().superRefine((effect, context) => {
  if (Object.keys(effect).length === 0) {
    context.addIssue({ code: "custom", message: "A rule effect cannot be empty" });
  }
  if (effect.scoreFloor !== undefined && effect.scoreCap !== undefined &&
      effect.scoreFloor > effect.scoreCap) {
    context.addIssue({
      code: "custom",
      message: "A score floor cannot exceed its score cap",
    });
  }
});

export const personalPriorityRuleSchema = z.object({
  ruleKey: z.string().min(1).max(128)
    .regex(/^personal\.[a-z0-9][a-z0-9._-]*$/),
  priority: z.number().int().min(0).max(1_000),
  label: durableBoundedTextSchema(200),
  appliesTo: z.enum(["page", "resource", "both"]),
  when: z.object({
    all: z.array(personalPriorityConditionSchema).min(1).max(8),
  }).strict(),
  effect: personalPriorityRuleEffectSchema,
}).strict().superRefine((rule, context) => {
  const resourceOnly = new Set([
    "resource_page_count",
    "resource_captured_page_count",
  ]);
  if (rule.appliesTo !== "resource" &&
      rule.when.all.some((condition) => resourceOnly.has(condition.signal))) {
    context.addIssue({
      code: "custom",
      message: "Resource-only signals require appliesTo=resource",
      path: ["when", "all"],
    });
  }
  const missingContent = rule.when.all.some((condition) =>
    condition.signal === "has_captured_content" && condition.operator === "eq" &&
    condition.value === false);
  if (missingContent && (
    rule.effect.scoreDelta !== undefined ||
    rule.effect.scoreFloor !== undefined ||
    rule.effect.scoreCap !== undefined ||
    rule.effect.exclusionReason !== undefined ||
    (rule.effect.confidenceDelta !== undefined && rule.effect.confidenceDelta >= 0) ||
    (rule.effect.needsReview !== undefined && rule.effect.needsReview !== true)
  )) {
    context.addIssue({
      code: "custom",
      message: "Missing content may only lower confidence or require review",
      path: ["effect"],
    });
  }
});

export type PersonalPriorityRule = z.infer<typeof personalPriorityRuleSchema>;

const structuredPersonalPriorityDraftSchema = z.object({
  kind: z.literal("structured"),
  additions: z.array(personalPriorityRuleSchema).max(92),
}).strict();
const naturalLanguagePersonalPriorityDraftSchema = z.object({
  kind: z.literal("natural_language"),
  locale: z.enum(["en", "ru"]),
  source: z.string().refine(
    (source) => [...source].length >= 1 && [...source].length <= 4_000,
    "Natural-language source must contain 1..4,000 Unicode code points",
  ).refine(
    (source) => new TextEncoder().encode(source).byteLength <= 8_192,
    "Natural-language source must contain at most 8,192 UTF-8 bytes",
  ),
}).strict();

export const personalPriorityDraftSchema = z.discriminatedUnion("kind", [
  structuredPersonalPriorityDraftSchema,
  naturalLanguagePersonalPriorityDraftSchema,
]);
export type PersonalPriorityDraft = z.infer<typeof personalPriorityDraftSchema>;

export const personalPrioritySourceSpanSchema = z.object({
  start: z.number().int().nonnegative().max(4_000),
  end: z.number().int().positive().max(4_000),
}).strict().refine((span) => span.end > span.start, {
  message: "Source span end must be after start",
});

export const personalPriorityCompiledRuleSpanSchema = z.object({
  ruleKey: z.string().min(1).max(128),
  rule: personalPrioritySourceSpanSchema,
  conditions: z.array(personalPrioritySourceSpanSchema).min(1).max(8),
  effects: z.array(personalPrioritySourceSpanSchema).min(1).max(6),
}).strict();

export const personalPriorityReadableRuleSchema = z.object({
  ruleKey: z.string().min(1).max(128),
  en: durableBoundedTextSchema(2_048),
  ru: durableBoundedTextSchema(2_048),
}).strict();

export const personalPriorityCompilerResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("structured"),
    compilerVersion: z.null(),
    sourceSpans: z.array(personalPriorityCompiledRuleSpanSchema).max(0),
    readableRules: z.array(personalPriorityReadableRuleSchema).max(92),
  }).strict(),
  z.object({
    kind: z.literal("natural_language"),
    compilerVersion: z.literal(personalPriorityCompilerVersion),
    sourceSpans: z.array(personalPriorityCompiledRuleSpanSchema).max(92),
    readableRules: z.array(personalPriorityReadableRuleSchema).max(92),
  }).strict(),
]);

export const personalPriorityCandidateSchema = z.object({
  additions: z.array(personalPriorityRuleSchema).max(92),
  astHash: durableFingerprintSchema,
  naturalLanguageSource: z.string().min(1).max(8_192).nullable(),
  totalRuleCount: z.number().int().min(8).max(100),
}).strict();

const personalPriorityPreviewAssessmentSchema = z.object({
  kind: z.literal("assessment"),
  agentScore: z.number().int().min(0).max(100),
  agentBand: priorityBandSchema,
  confidence: z.number().finite().min(0).max(1),
  needsReview: z.boolean(),
  reasons: z.array(z.object({
    code: durableBoundedTextSchema(256),
    kind: z.enum(["contribution", "conflict", "review"]),
    label: durableBoundedTextSchema(1_024),
    scoreDelta: z.number().finite().optional(),
    confidenceDelta: z.number().finite().optional(),
    appliedRuleKey: durableBoundedTextSchema(256).optional(),
    ignoredRuleKey: durableBoundedTextSchema(256).optional(),
  }).strict()).max(102),
  missingSignals: z.array(durableBoundedTextSchema(256)).max(20),
}).strict();
const personalPriorityPreviewExclusionSchema = z.object({
  kind: z.literal("exclusion"),
  reason: priorityExclusionReasonSchema,
  detail: z.record(z.string(), z.unknown()),
}).strict();
export const personalPriorityPreviewOutcomeSchema = z.discriminatedUnion("kind", [
  personalPriorityPreviewAssessmentSchema,
  personalPriorityPreviewExclusionSchema,
]);

export const personalPriorityPreviewRequestSchema = z.object({
  draft: personalPriorityDraftSchema,
}).strict();
export const personalPriorityPreviewResponseSchema = z.object({
  compiler: personalPriorityCompilerResultSchema,
  candidate: personalPriorityCandidateSchema,
  diff: z.object({
    added: z.array(z.string().min(1).max(128)).max(92),
    changed: z.array(z.string().min(1).max(128)).max(92),
    removed: z.array(z.string().min(1).max(128)).max(92),
  }).strict(),
  examples: z.array(z.object({
    logicalPageId: durablePositiveSafeIntegerSchema,
    display: z.object({
      title: z.string().max(snapshotTabTitleMaxLength).nullable(),
      representativeUrl: tabUrlSchema,
    }).strict(),
    stratum: z.enum([
      "exclusion_changed",
      "band_changed",
      "assessment_changed",
      "unchanged",
    ]),
    before: personalPriorityPreviewOutcomeSchema,
    after: personalPriorityPreviewOutcomeSchema,
  }).strict()).max(20),
  eligibleCount: z.number().int().nonnegative().max(10_000),
  scannedCount: z.number().int().nonnegative().max(10_000),
  comparedActiveRef: priorityRulesetRefContractSchema,
  comparedActiveAstHash: durableFingerprintSchema,
  requestFingerprint: durableFingerprintSchema,
}).strict();

export const personalPriorityRulesetVersionSchema = z.object({
  ref: priorityRulesetRefContractSchema,
  createdBy: z.enum(["user", "agent"]),
  createdAt: durableTimestampSchema,
  naturalLanguageSource: z.string().min(1).max(8_192).nullable(),
  astHash: durableFingerprintSchema,
  additions: z.array(personalPriorityRuleSchema).max(92),
  active: z.boolean(),
}).strict();

export const personalPriorityRulesStateResponseSchema = z.object({
  name: z.literal("Personal priority rules"),
  baselineRef: priorityRulesetRefContractSchema,
  activeRef: priorityRulesetRefContractSchema,
  latestVersion: z.number().int().positive().nullable(),
  versions: z.array(personalPriorityRulesetVersionSchema).max(1_000),
  versionCount: z.number().int().nonnegative(),
  historyTruncated: z.boolean(),
  recomputeRequired: z.boolean(),
  staleOutcomeCount: z.number().int().nonnegative(),
}).strict();

const personalPriorityRequestFingerprintSchema = durableFingerprintSchema;
const personalPriorityActiveRefSchema = priorityRulesetRefContractSchema;
const personalPrioritySaveRequestSchema = z.object({
  kind: z.literal("save"),
  draft: personalPriorityDraftSchema,
  expectedLatestVersion: z.number().int().positive().nullable(),
  expectedActiveRef: personalPriorityActiveRefSchema,
  requestFingerprint: personalPriorityRequestFingerprintSchema,
}).strict();
const personalPriorityActivateRequestSchema = z.object({
  kind: z.literal("activate"),
  target: priorityRulesetRefContractSchema,
  expectedActiveRef: personalPriorityActiveRefSchema,
  requestFingerprint: personalPriorityRequestFingerprintSchema,
}).strict();
const personalPriorityRollbackRequestSchema = z.object({
  kind: z.literal("rollback"),
  target: priorityRulesetRefContractSchema,
  expectedActiveRef: personalPriorityActiveRefSchema,
  requestFingerprint: personalPriorityRequestFingerprintSchema,
}).strict();
const personalPriorityDisableRequestSchema = z.object({
  kind: z.literal("disable"),
  expectedActiveRef: personalPriorityActiveRefSchema,
  requestFingerprint: personalPriorityRequestFingerprintSchema,
}).strict();
const personalPriorityResetRequestSchema = z.object({
  kind: z.literal("reset"),
  expectedLatestVersion: z.number().int().positive().nullable(),
  expectedActiveRef: personalPriorityActiveRefSchema,
  requestFingerprint: personalPriorityRequestFingerprintSchema,
}).strict();

export const personalPriorityLifecycleRequestSchema = z.discriminatedUnion("kind", [
  personalPrioritySaveRequestSchema,
  personalPriorityActivateRequestSchema,
  personalPriorityDisableRequestSchema,
  personalPriorityResetRequestSchema,
  personalPriorityRollbackRequestSchema,
]);
export type PersonalPriorityLifecycleRequest = z.infer<
  typeof personalPriorityLifecycleRequestSchema
>;

export const personalPriorityLifecycleResponseSchema = z.object({
  operation: z.enum(["save", "activate", "disable", "reset", "rollback"]),
  target: priorityRulesetRefContractSchema,
  activeRef: priorityRulesetRefContractSchema,
  latestVersion: z.number().int().positive().nullable(),
  requestFingerprint: durableFingerprintSchema,
  replayed: z.boolean(),
  changed: z.boolean(),
  recomputeRequired: z.boolean(),
  staleOutcomeCount: z.number().int().nonnegative(),
}).strict();

export const personalPriorityRuleErrorCodeSchema = z.enum([
  "PRIORITY_RULE_LANGUAGE_UNSUPPORTED",
  "INVALID_PRIORITY_RULESET",
  "PRIORITY_RULESET_CONFLICT",
  "PRIORITY_RULESET_NOT_FOUND",
  "PRIORITY_RULESET_VERSION_NOT_FOUND",
  "PRIORITY_RULE_PREVIEW_LIMIT",
  "PRIORITY_RULE_PREVIEW_TIMEOUT",
  "PRIORITY_FEATURE_UNAVAILABLE",
]);
export type PersonalPriorityRuleErrorCode = z.infer<
  typeof personalPriorityRuleErrorCodeSchema
>;
export const personalPriorityRuleErrorResponseSchema = z.object({
  error: personalPriorityRuleErrorCodeSchema,
  message: durableBoundedTextSchema(1_024),
  span: personalPrioritySourceSpanSchema.optional(),
}).strict();

const priorityReasonContractSchema = z.object({
  code: durableBoundedTextSchema(256),
  kind: z.enum(["contribution", "conflict", "review"]),
  label: durableBoundedTextSchema(1_024),
  scoreDelta: z.number().finite().optional(),
  confidenceDelta: z.number().finite().optional(),
  appliedRuleKey: durableBoundedTextSchema(256).optional(),
  ignoredRuleKey: durableBoundedTextSchema(256).optional(),
}).strict();

export const priorityAssessmentContractSchema = z.object({
  id: durablePositiveSafeIntegerSchema,
  subject: prioritySubjectSchema,
  agentScore: z.number().int().min(0).max(100),
  agentBand: priorityBandSchema,
  confidence: z.number().finite().min(0).max(1),
  needsReview: z.boolean(),
  reasons: z.array(priorityReasonContractSchema).max(102),
  missingSignals: z.array(durableBoundedTextSchema(256)).max(100),
  ruleset: priorityRulesetRefContractSchema,
  featureFingerprint: durableFingerprintSchema,
  assessmentMethod: z.enum(["rule", "model"]),
  modelProvenance: z.object({
    provider: durableBoundedTextSchema(128),
    name: durableBoundedTextSchema(128),
    promptVersion: durableBoundedTextSchema(128),
  }).strict().nullable(),
  revision: durablePositiveSafeIntegerSchema,
  evaluatedAt: durableTimestampSchema,
  supersededAt: durableTimestampSchema.nullable(),
}).strict();

export const priorityExclusionContractSchema = z.object({
  id: durablePositiveSafeIntegerSchema,
  subject: prioritySubjectSchema,
  reason: priorityExclusionReasonSchema,
  detail: z.record(z.string(), z.unknown()),
  ruleset: priorityRulesetRefContractSchema,
  featureFingerprint: durableFingerprintSchema,
  revision: durablePositiveSafeIntegerSchema,
  evaluatedAt: durableTimestampSchema,
  supersededAt: durableTimestampSchema.nullable(),
}).strict();

export const priorityOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assessment"), assessment: priorityAssessmentContractSchema }).strict(),
  z.object({ kind: z.literal("exclusion"), exclusion: priorityExclusionContractSchema }).strict(),
]);

export type PriorityOutcomeContract = z.infer<typeof priorityOutcomeSchema>;

export const prioritySafeReadSchema = z.object({
  subject: prioritySubjectSchema,
  outcome: priorityOutcomeSchema.nullable(),
  isCurrent: z.boolean(),
  dirty: z.boolean(),
  needsReview: z.boolean(),
}).strict();

export type PrioritySafeRead = z.infer<typeof prioritySafeReadSchema>;

export const priorityReadBatchRequestSchema = z.object({
  subjects: z.array(prioritySubjectSchema).max(100),
}).strict();
export const priorityReadBatchResponseSchema = z.object({
  items: z.array(prioritySafeReadSchema).max(100),
}).strict();

export const priorityReviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1_024).optional(),
}).strict();
export const priorityReviewQueueResponseSchema = z.object({
  items: z.array(prioritySafeReadSchema).max(100),
  nextCursor: z.string().min(1).max(1_024).nullable(),
}).strict();

export const agentUserImportanceRequestSchema = z.object({
  subject: prioritySubjectSchema,
  value: userImportanceSchema.nullable(),
  authorizationRef: durableBoundedTextSchema(256),
  idempotencyKey: durableBoundedTextSchema(200),
}).strict();

export type AgentUserImportanceRequest = z.infer<
  typeof agentUserImportanceRequestSchema
>;

export const agentUserImportanceResponseSchema = z.object({
  subject: prioritySubjectSchema,
  value: userImportanceSchema.nullable(),
  provenance: z.object({
    actor: z.literal("agent"),
    method: z.literal("on_behalf_of_user"),
  }).strict(),
  updatedAt: durableTimestampSchema,
}).strict();

export type AgentUserImportanceResponse = z.infer<
  typeof agentUserImportanceResponseSchema
>;

export const agentResourceUserEvaluationRequestSchema = z.object({
  evaluation: userImportanceSchema.nullable(),
  authorizationRef: durableBoundedTextSchema(256),
  idempotencyKey: durableBoundedTextSchema(200),
}).strict();

export const priorityFeedbackVerdictContractSchema = z.enum([
  "accept", "reject", "too_high", "too_low",
]);
export const localPriorityFeedbackRequestSchema = z.object({
  assessmentId: durablePositiveSafeIntegerSchema,
  verdict: priorityFeedbackVerdictContractSchema,
  note: z.string().trim().min(1).max(4096).optional(),
  idempotencyKey: durableBoundedTextSchema(200),
  supersedesId: durablePositiveSafeIntegerSchema.optional(),
}).strict();
export const agentPriorityFeedbackRequestSchema = localPriorityFeedbackRequestSchema.extend({
  authorizationRef: durableBoundedTextSchema(256),
}).strict();

export const priorityFeedbackReceiptSchema = z.object({
  id: durablePositiveSafeIntegerSchema,
  subject: prioritySubjectSchema,
  assessmentId: durablePositiveSafeIntegerSchema,
  verdict: priorityFeedbackVerdictContractSchema,
  note: z.string().max(4096).nullable(),
  provenance: z.discriminatedUnion("actor", [
    z.object({ actor: z.literal("user"), method: z.literal("manual") }).strict(),
    z.object({
      actor: z.literal("agent"),
      method: z.literal("on_behalf_of_user"),
    }).strict(),
  ]),
  supersedesId: durablePositiveSafeIntegerSchema.nullable(),
  supersededAt: durableTimestampSchema.nullable(),
  revision: durablePositiveSafeIntegerSchema,
  createdAt: durableTimestampSchema,
}).strict();

export type PriorityFeedbackReceipt = z.infer<typeof priorityFeedbackReceiptSchema>;

export const localPriorityRecomputeRequestSchema = z.object({
  subject: prioritySubjectSchema.optional(),
  idempotencyKey: durableBoundedTextSchema(200),
  stepBatchSize: z.number().int().min(1).max(100).default(50),
}).strict();
export const agentPriorityRecomputeRequestSchema = localPriorityRecomputeRequestSchema.extend({
  authorizationRef: durableBoundedTextSchema(256),
}).strict();

export const durableJobIdParamSchema = z.object({
  id: durableJobIdSchema,
}).strict();

export const embeddingReindexRequestSchema = z.object({
  limit: z.number().int().positive().max(1_000).default(100),
});

export type EmbeddingReindexRequest = z.infer<
  typeof embeddingReindexRequestSchema
>;

export const embeddingReindexResponseSchema = z.object({
  indexed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  dimensions: z.literal(512),
});

export type EmbeddingReindexResponse = z.infer<
  typeof embeddingReindexResponseSchema
>;

export const clusterInboxRequestSchema = z.object({
  maxClusters: z.number().int().min(1).max(50).default(8),
});

export type ClusterInboxRequest = z.infer<typeof clusterInboxRequestSchema>;

export const inboxClusterSchema = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  tabIds: z.array(tabIdSchema),
  size: z.number().int().nonnegative(),
});

export type InboxCluster = z.infer<typeof inboxClusterSchema>;

export const clusterInboxResponseSchema = z.object({
  clusters: z.array(inboxClusterSchema),
  indexed: z.number().int().nonnegative(),
  unclustered: z.number().int().nonnegative(),
});

export type ClusterInboxResponse = z.infer<
  typeof clusterInboxResponseSchema
>;

type TagTreeNodeShape = {
  id: number;
  name: string;
  path: string;
  color: string | null;
  tabCount: number;
  children: TagTreeNodeShape[];
};

export const tagTreeNodeSchema: z.ZodType<TagTreeNodeShape> = z.lazy(() =>
  z.object({
    id: tabIdSchema,
    name: persistedTagNameSchema,
    path: persistedTagPathSchema,
    color: tagColorSchema,
    tabCount: z.number().int().nonnegative(),
    children: z.array(tagTreeNodeSchema),
  }),
);

export type TagTreeNode = z.infer<typeof tagTreeNodeSchema>;

export const tagTreeResponseSchema = z.object({
  items: z.array(tagTreeNodeSchema),
});

export type TagTreeResponse = z.infer<typeof tagTreeResponseSchema>;

export const statusCountSchema = z.object({
  status: tabStatusSchema,
  count: z.number().int().nonnegative(),
});

export type StatusCount = z.infer<typeof statusCountSchema>;

const statusCountsSchema = z.array(statusCountSchema).max(4);

export const browserStatsSchema = z.object({
  browser: browserIdentifierSchema,
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
});

export type BrowserStats = z.infer<typeof browserStatsSchema>;

export const tagStatsSchema = z.object({
  tagId: tabIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  total: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
});

export type TagStats = z.infer<typeof tagStatsSchema>;

export const statsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
  byBrowser: z.array(browserStatsSchema),
  byTag: z.array(tagStatsSchema),
});

export type StatsResponse = z.infer<typeof statsResponseSchema>;

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1" || value === 1) {
    return true;
  }

  if (value === "false" || value === "0" || value === 0) {
    return false;
  }

  return value;
}, z.boolean());

const tabFilterQueryShape = {
  browser: browserIdentifierSchema.optional(),
  duplicates_only: queryBooleanSchema.default(false),
  is_open: queryBooleanSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  status: tabStatusSchema.optional(),
  importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
  tag: tagPathSchema.optional(),
  resource_id: z.coerce.number().int().positive().optional(),
  needs_review: queryBooleanSchema.optional(),
};

export const tabBulkIdsQuerySchema = z.object(tabFilterQueryShape);

export type TabBulkIdsQuery = z.infer<typeof tabBulkIdsQuerySchema>;

export const tabBulkIdsResponseSchema = z.object({
  ids: z
    .array(tabIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique"),
  logicalPageCount: z.number().int().nonnegative(),
});

export type TabBulkIdsResponse = z.infer<typeof tabBulkIdsResponseSchema>;

export const tabSortFieldSchema = z.enum([
  "title",
  "topics",
  "browser",
  "activity",
  "status",
  "importance",
  "state",
  "age",
]);

export type TabSortField = z.infer<typeof tabSortFieldSchema>;

export const sortDirectionSchema = z.enum(["asc", "desc"]);

export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const priorityModeSchema = z.enum(["my", "ai", "recommended"]);

export type PriorityMode = z.infer<typeof priorityModeSchema>;

export const prioritySearchModeConflictCode =
  "PRIORITY_SEARCH_MODE_CONFLICT" as const;

export const prioritySearchModeConflictErrorSchema = z.strictObject({
  error: z.literal(prioritySearchModeConflictCode),
  message: z.string().min(1),
});

export type PrioritySearchModeConflictError = z.infer<
  typeof prioritySearchModeConflictErrorSchema
>;

export const tabListQuerySchema = z
  .object({
    ...tabFilterQueryShape,
    search_mode: searchModeSchema.default("fulltext"),
    similar_to: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
    priority_mode: priorityModeSchema.optional(),
    needs_review: queryBooleanSchema.optional(),
    sort_by: tabSortFieldSchema.optional(),
    sort_direction: sortDirectionSchema.optional(),
  })
  .superRefine((query, context) => {
    if (query.q !== undefined && query.similar_to !== undefined) {
      context.addIssue({
        code: "custom",
        message: "q and similar_to cannot be combined",
      });
    }

    if (
      query.search_mode === "semantic" &&
      query.q === undefined &&
      query.similar_to === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Semantic search requires q or similar_to",
      });
    }

    if (query.sort_by === undefined && query.sort_direction !== undefined) {
      context.addIssue({
        code: "custom",
        message: "sort_direction requires sort_by",
        path: ["sort_direction"],
      });
    }

    if (
      query.sort_by !== undefined &&
      (query.search_mode === "semantic" || query.similar_to !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Column sorting cannot be combined with relevance ranking",
        path: ["sort_by"],
      });
    }

    if (
      (query.priority_mode !== undefined || query.needs_review !== undefined) &&
      (query.search_mode === "semantic" || query.similar_to !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: prioritySearchModeConflictCode,
        path: ["priority_mode"],
      });
    }

    if (query.priority_mode !== undefined && query.sort_by === "importance") {
      context.addIssue({
        code: "custom",
        message: "importance cannot be a secondary priority sort",
        path: ["sort_by"],
      });
    }

  });

export type TabListQuery = z.infer<typeof tabListQuerySchema>;

export const tabListResponseSchema = z.object({
  items: z.array(tabListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type TabListResponse = z.infer<typeof tabListResponseSchema>;

export const localTabListResponseSchema = tabListResponseSchema.extend({
  items: z.array(localTabListItemSchema),
});

export type LocalTabListResponse = z.infer<typeof localTabListResponseSchema>;

export const retentionReviewQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type RetentionReviewQuery = z.infer<
  typeof retentionReviewQuerySchema
>;

export const retentionReviewResponseSchema = z.object({
  items: z.array(retentionCandidateSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type RetentionReviewResponse = z.infer<
  typeof retentionReviewResponseSchema
>;

export const retentionTrashResponseSchema = z.object({
  items: z.array(retentionTrashItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type RetentionTrashResponse = z.infer<
  typeof retentionTrashResponseSchema
>;

export const tabInstanceListQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  resource_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).max(500).optional(),
  duplicates_only: queryBooleanSchema.default(false),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type TabInstanceListQuery = z.infer<
  typeof tabInstanceListQuerySchema
>;

export const tabInstanceListResponseSchema = z.object({
  items: z.array(tabInstanceSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type TabInstanceListResponse = z.infer<
  typeof tabInstanceListResponseSchema
>;

export const tabInstanceBulkQuerySchema = tabInstanceListQuerySchema.pick({
  browser: true,
  resource_id: true,
  q: true,
  duplicates_only: true,
});

export type TabInstanceBulkQuery = z.infer<
  typeof tabInstanceBulkQuerySchema
>;

export const tabInstanceBulkResponseSchema = z.object({
  items: z.array(tabInstanceSchema),
  total: z.number().int().nonnegative(),
  logicalPageCount: z.number().int().nonnegative(),
});

export type TabInstanceBulkResponse = z.infer<
  typeof tabInstanceBulkResponseSchema
>;

export const resourceKindSchema = z.enum([
  "website",
  "platform",
  "collection",
]);

export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const resourceAccessClassSchema = z.enum([
  "public",
  "authenticated",
  "sensitive",
]);

export type ResourceAccessClass = z.infer<typeof resourceAccessClassSchema>;

export const resourceLifecycleStateSchema = z.enum(["active", "merged"]);

export type ResourceLifecycleState = z.infer<
  typeof resourceLifecycleStateSchema
>;

export const resourceRefSchema = z
  .object({
    id: z.number().int().positive(),
    resourceKey: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: resourceKindSchema,
    accessClass: resourceAccessClassSchema,
    lifecycleState: resourceLifecycleStateSchema,
    mergedIntoResourceId: z.number().int().positive().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const resourceResolvedReasonSchema = z.enum([
  "user_manual",
  "agent_on_behalf",
  "explicit_alias",
  "system_seed",
  "registrable_domain",
]);

export const resourceUnmatchedReasonSchema = z.enum([
  "weak_sensitive_signal",
  "registrable_domain_unavailable",
  "invalid_url",
]);

export const resourceExclusionReasonSchema = z.enum([
  "browser_internal",
  "extension",
  "file",
  "data",
  "unsupported_scheme",
  "embedded_credentials",
  "localhost",
  "private_ip",
  "private_hostname",
]);

export const resourceResearchExclusionReasonSchema = z.union([
  resourceExclusionReasonSchema,
  resourceUnmatchedReasonSchema,
  z.enum(["authenticated_access", "sensitive_access"]),
]);

const resourceResolutionCommonSchema = z.object({
  logicalPageId: z.number().int().positive(),
  candidateResourceIds: z.array(z.number().int().positive()),
  sourceFingerprint: z.string().trim().min(1),
  resolvedAt: z.string().datetime(),
});

export const resourceResolutionSchema = z
  .discriminatedUnion("state", [
    resourceResolutionCommonSchema
    .extend({
      state: z.literal("resolved"),
      reason: resourceResolvedReasonSchema,
      resource: resourceRefSchema,
      researchEligible: z.boolean(),
      researchExclusionReason: resourceResearchExclusionReasonSchema.nullable(),
    })
      .strict(),
    resourceResolutionCommonSchema
    .extend({
      state: z.literal("unmatched"),
      reason: resourceUnmatchedReasonSchema,
      resource: z.null(),
      researchEligible: z.literal(false),
      researchExclusionReason: resourceResearchExclusionReasonSchema,
    })
      .strict(),
    resourceResolutionCommonSchema
    .extend({
      state: z.literal("ambiguous"),
      reason: z.literal("authoritative_tie"),
      resource: z.null(),
      candidateResourceIds: z.array(z.number().int().positive()).min(2),
      researchEligible: z.literal(false),
      researchExclusionReason: z.literal("authoritative_tie"),
    })
      .strict(),
    resourceResolutionCommonSchema
    .extend({
      state: z.literal("excluded"),
      reason: resourceExclusionReasonSchema,
      resource: z.null(),
      researchEligible: z.literal(false),
      researchExclusionReason: resourceExclusionReasonSchema,
    })
      .strict(),
  ])
  .superRefine((resolution, context) => {
    const candidates = resolution.candidateResourceIds;
    const canonicalCandidates = [...new Set(candidates)].sort(
      (left, right) => left - right,
    );
    if (
      candidates.length !== canonicalCandidates.length ||
      candidates.some((candidate, index) => candidate !== canonicalCandidates[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Resource candidate IDs must be distinct and sorted",
        path: ["candidateResourceIds"],
      });
      return;
    }
    if (
      resolution.state === "resolved" &&
      (candidates.length !== 1 || candidates[0] !== resolution.resource.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "A resolved outcome must name exactly its selected resource",
        path: ["candidateResourceIds"],
      });
    }
    if (
      resolution.state === "ambiguous" &&
      candidates.length < 2
    ) {
      context.addIssue({
        code: "custom",
        message: "An ambiguous outcome requires at least two distinct resources",
        path: ["candidateResourceIds"],
      });
    }
    if (
      (resolution.state === "unmatched" || resolution.state === "excluded") &&
      candidates.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An unmatched or excluded outcome cannot name resource candidates",
        path: ["candidateResourceIds"],
      });
    }
  });

export type ResourceResolution = z.infer<typeof resourceResolutionSchema>;

export const resourceReviewQueueItemSchema = z
  .object({
    logicalPageId: z.number().int().positive(),
    urlNormalized: z.string().min(1),
    state: z.enum(["unmatched", "ambiguous"]),
    reason: z.union([
      resourceUnmatchedReasonSchema,
      z.literal("authoritative_tie"),
    ]),
    candidateResourceIds: z.array(z.number().int().positive()),
    currentAssignmentId: z.number().int().positive().nullable(),
    sourceFingerprint: z.string().trim().min(1),
    resolvedAt: z.string().datetime(),
  })
  .strict();

export type ResourceReviewQueueItem = z.infer<
  typeof resourceReviewQueueItemSchema
>;

export const resourceReviewQueueQuerySchema = z
  .object({
    resolution: z.literal("unmatched_or_ambiguous").default("unmatched_or_ambiguous"),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

export type ResourceReviewQueueQuery = z.infer<
  typeof resourceReviewQueueQuerySchema
>;

export const resourceReviewQueueResponseSchema = z
  .object({
    items: z.array(resourceReviewQueueItemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();

export type ResourceReviewQueueResponse = z.infer<
  typeof resourceReviewQueueResponseSchema
>;

export const resourceCountsSchema = z.object({
  logicalPageCount: z.number().int().nonnegative(),
  browserPageCount: z.number().int().nonnegative(),
  physicalOpenCopyCount: z.number().int().nonnegative(),
});

export const resourceAllTimeActivitySchema = z.object({
  window: z.literal("all"),
  onScreenMs: z.number().int().nonnegative(),
  activeUseMs: z.number().int().nonnegative(),
  coverageStart: z.string().datetime().nullable(),
});

export const resourceActivityQuerySchema = z
  .object({ window: activityWindowSchema.default("all") })
  .strict();

export const resourceActivityResponseSchema = z
  .object({
    resourceId: z.number().int().positive(),
    activity: activityRollupSchema,
  })
  .strict();

export const resourceUserEvaluationSchema = z.number().int().min(1).max(3);

export const resourceCommandProvenanceSchema = z.union([
  contextUserProvenanceSchema,
  contextAgentOnBehalfProvenanceSchema,
]);

export type ResourceCommandProvenance = z.infer<
  typeof resourceCommandProvenanceSchema
>;

export const resourcePreferenceSchema = z
  .object({
    userEvaluation: resourceUserEvaluationSchema.nullable(),
    provenance: resourceCommandProvenanceSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((preference, context) => {
    if ((preference.userEvaluation === null) !== (preference.provenance === null)) {
      context.addIssue({
        code: "custom",
        message: "Resource evaluation and provenance must be present together",
      });
    }
  });

export const resourceSummarySchema = z.object({
  resource: resourceRefSchema,
  version: z.number().int().positive(),
  preference: resourcePreferenceSchema,
  counts: resourceCountsSchema,
  allTimeActivity: resourceAllTimeActivitySchema,
  topicPaths: z.array(z.string().min(1)),
});

export type ResourceSummary = z.infer<typeof resourceSummarySchema>;

export const resourceListQuerySchema = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  kind: resourceKindSchema.optional(),
  accessClass: resourceAccessClassSchema.optional(),
  lifecycleState: resourceLifecycleStateSchema.default("active"),
  browser: browserIdentifierSchema.optional(),
  status: tabStatusSchema.optional(),
  importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
  tag: tagPathSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  priority_mode: priorityModeSchema.optional(),
  needs_review: queryBooleanSchema.optional(),
  sort_by: z.enum(["name", "logical_pages", "activity", "updated_at"]).default("name"),
  sort_direction: sortDirectionSchema.default("asc"),
});

export type ResourceListQuery = z.infer<typeof resourceListQuerySchema>;

export const resourceListResponseSchema = z.object({
  items: z.array(resourceSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type ResourceListResponse = z.infer<typeof resourceListResponseSchema>;

export const resourceAliasViewSchema = z.object({
  ruleKey: z.string().min(1),
  version: z.number().int().positive(),
  hostPattern: z.string().trim().min(1).max(253),
  matchKind: z.enum(["exact_host", "suffix_host"]),
  pathPrefix: z.string().trim().min(1).max(2_048),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  enabled: z.boolean(),
  provenance: z.enum(["user_alias", "agent_alias", "system_seed"]),
});

export const resourceDetailSchema = resourceSummarySchema.extend({
  rulesetVersion: z.number().int().positive(),
  aliases: z.array(resourceAliasViewSchema),
});

export type ResourceDetail = z.infer<typeof resourceDetailSchema>;

export const resourcePageItemSchema = z.object({
  logicalPageId: z.number().int().positive(),
  urlNormalized: z.string().min(1),
  representativeUrl: z.string().min(1),
  browserPageCount: z.number().int().nonnegative(),
  physicalOpenCopyCount: z.number().int().nonnegative(),
  browsers: z.array(browserIdentifierSchema),
  topicPaths: z.array(z.string().min(1)),
  allTimeActivity: resourceAllTimeActivitySchema,
  currentAssignmentId: z.number().int().positive(),
  assignmentReason: resourceResolvedReasonSchema,
});

export const resourcePagesQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  status: tabStatusSchema.optional(),
  importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
  tag: tagPathSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type ResourcePagesQuery = z.infer<typeof resourcePagesQuerySchema>;

export const resourcePagesResponseSchema = z.object({
  items: z.array(resourcePageItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type ResourcePagesResponse = z.infer<typeof resourcePagesResponseSchema>;

export const localResourceContextViewSchema = z.object({
  context: contextBundleSchema,
  counts: resourceCountsSchema,
});

export const resourceIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const resourceCommandIdempotencyKeySchema = z.string().trim().min(1).max(256);

export const resourceAliasSchema = z
  .object({
    hostPattern: z.string().trim().min(1).max(253),
    matchKind: z.enum(["exact_host", "suffix_host"]),
    pathPrefix: z.string().trim().min(1).max(2_048),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .strict();

export type ResourceAlias = z.infer<typeof resourceAliasSchema>;

const resourceCommandCommonSchema = z.object({
  idempotencyKey: resourceCommandIdempotencyKeySchema,
  provenance: resourceCommandProvenanceSchema,
});

export const resourceCreateCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("create"),
    resourceKey: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(512),
    resourceKind: resourceKindSchema,
    accessClass: resourceAccessClassSchema,
  })
  .strict();

export const resourceSetAliasesCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("set_aliases"),
    resourceId: z.number().int().positive(),
    aliases: z.array(resourceAliasSchema).max(10_000),
    expectedResourceVersion: z.number().int().positive(),
    expectedRulesetVersion: z.number().int().positive(),
  })
  .strict();

export const resourceApplyOverrideCommandSchema = z
  .object({
    kind: z.literal("apply_override"),
    logicalPageId: z.number().int().positive(),
    resourceId: z.number().int().positive().nullable(),
    expectedAssignmentId: z.number().int().positive().nullable(),
    provenance: contextUserProvenanceSchema,
    idempotencyKey: resourceCommandIdempotencyKeySchema,
  })
  .strict();

export const resourceMergeCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("merge"),
    sourceResourceId: z.number().int().positive(),
    targetResourceId: z.number().int().positive(),
    expectedSourceVersion: z.number().int().positive(),
    expectedTargetVersion: z.number().int().positive(),
    expectedRulesetVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.sourceResourceId === command.targetResourceId) {
      context.addIssue({
        code: "custom",
        message: "Merge source and target must be different resources",
        path: ["targetResourceId"],
      });
    }
  });

export const resourceSplitTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      resourceId: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("new"),
      resourceKey: z.string().trim().min(1).max(256),
      name: z.string().trim().min(1).max(512),
      resourceKind: resourceKindSchema,
      accessClass: resourceAccessClassSchema,
    })
    .strict(),
]);

export const resourceSplitCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("split"),
    sourceResourceId: z.number().int().positive(),
    expectedSourceVersion: z.number().int().positive(),
    logicalPageIds: z.array(z.number().int().positive()).min(1).max(100_000),
    target: resourceSplitTargetSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.target.kind === "existing" &&
      command.target.resourceId === command.sourceResourceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Split target must be different from its source",
        path: ["target", "resourceId"],
      });
    }
  });

export const resourceRenameCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("rename"),
    resourceId: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(512),
  })
  .strict();

// Reserved by migration 020 and the public contract; C30c owns its behavior.
export const resourceSetUserEvaluationCommandSchema = resourceCommandCommonSchema
  .extend({
    kind: z.literal("set_user_evaluation"),
    resourceId: z.number().int().positive(),
    evaluation: z.number().int().min(1).max(3).nullable(),
  })
  .strict();

export const resourceCatalogCommandSchema = z.union([
  resourceCreateCommandSchema,
  resourceSetAliasesCommandSchema,
  resourceApplyOverrideCommandSchema,
  resourceMergeCommandSchema,
  resourceSplitCommandSchema,
  resourceRenameCommandSchema,
]);

export type ResourceCatalogCommand = z.infer<
  typeof resourceCatalogCommandSchema
>;

export const resourceCommandSchema = z.union([
  resourceCreateCommandSchema,
  resourceSetAliasesCommandSchema,
  resourceApplyOverrideCommandSchema,
  resourceMergeCommandSchema,
  resourceSplitCommandSchema,
  resourceRenameCommandSchema,
  resourceSetUserEvaluationCommandSchema,
]);

export type ResourceCommand = z.infer<typeof resourceCommandSchema>;

const localResourceCommandCommonSchema = z.object({
  idempotencyKey: resourceCommandIdempotencyKeySchema,
});

const localResourceMergeCommandSchema = localResourceCommandCommonSchema.extend({
  kind: z.literal("merge"),
  sourceResourceId: z.number().int().positive(),
  targetResourceId: z.number().int().positive(),
  expectedSourceVersion: z.number().int().positive(),
  expectedTargetVersion: z.number().int().positive(),
  expectedRulesetVersion: z.number().int().positive(),
}).strict().superRefine((command, context) => {
  if (command.sourceResourceId === command.targetResourceId) {
    context.addIssue({ code: "custom", message: "Merge source and target must be different resources",
      path: ["targetResourceId"] });
  }
});

const localResourceSplitCommandSchema = localResourceCommandCommonSchema.extend({
  kind: z.literal("split"),
  sourceResourceId: z.number().int().positive(),
  expectedSourceVersion: z.number().int().positive(),
  logicalPageIds: z.array(z.number().int().positive()).min(1).max(100_000),
  target: resourceSplitTargetSchema,
}).strict().superRefine((command, context) => {
  if (command.target.kind === "existing" && command.target.resourceId === command.sourceResourceId) {
    context.addIssue({ code: "custom", message: "Split target must be different from its source",
      path: ["target", "resourceId"] });
  }
});

export const localResourceCommandSchema = z.union([
  localResourceCommandCommonSchema.extend({
    kind: z.literal("create"), resourceKey: resourceCreateCommandSchema.shape.resourceKey,
    name: resourceCreateCommandSchema.shape.name,
    resourceKind: resourceKindSchema, accessClass: resourceAccessClassSchema,
  }).strict(),
  localResourceCommandCommonSchema.extend({
    kind: z.literal("set_aliases"), resourceId: z.number().int().positive(),
    aliases: z.array(resourceAliasSchema).max(10_000),
    expectedResourceVersion: z.number().int().positive(),
    expectedRulesetVersion: z.number().int().positive(),
  }).strict(),
  localResourceCommandCommonSchema.extend({
    kind: z.literal("apply_override"), logicalPageId: z.number().int().positive(),
    resourceId: z.number().int().positive().nullable(),
    expectedAssignmentId: z.number().int().positive().nullable(),
  }).strict(),
  localResourceMergeCommandSchema,
  localResourceSplitCommandSchema,
  localResourceCommandCommonSchema.extend({
    kind: z.literal("rename"), resourceId: z.number().int().positive(),
    expectedVersion: z.number().int().positive(), name: resourceRenameCommandSchema.shape.name,
  }).strict(),
]);

export type LocalResourceCommand = z.infer<typeof localResourceCommandSchema>;

export const resourceUserEvaluationRequestSchema = z
  .object({
    evaluation: resourceUserEvaluationSchema.nullable(),
    idempotencyKey: resourceCommandIdempotencyKeySchema,
  })
  .strict();

export const contextLifecycleRequestSchema = z
  .object({ idempotencyKey: contextIdempotencyKeySchema })
  .strict();

export const contextReviewRequestSchema = contextLifecycleRequestSchema
  .extend({ verdict: contextReviewVerdictSchema })
  .strict();

export const resourceCommandResourceSchema = z
  .object({
    resource: resourceRefSchema,
    version: z.number().int().positive(),
  })
  .strict();

export type ResourceCommandResource = z.infer<
  typeof resourceCommandResourceSchema
>;

export const resourceCommandResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      changed: z.boolean(),
      resource: resourceCommandResourceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_aliases"),
      changed: z.boolean(),
      resourceId: z.number().int().positive(),
      aliases: z.array(resourceAliasSchema),
      rulesetVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply_override"),
      changed: z.boolean(),
      logicalPageId: z.number().int().positive(),
      resource: resourceCommandResourceSchema.nullable(),
      resolution: resourceResolutionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge"),
      changed: z.boolean(),
      source: resourceCommandResourceSchema,
      target: resourceCommandResourceSchema,
      movedLogicalPageIds: z.array(z.number().int().positive()),
      rulesetVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("split"),
      changed: z.boolean(),
      source: resourceCommandResourceSchema,
      target: resourceCommandResourceSchema,
      movedLogicalPageIds: z.array(z.number().int().positive()).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rename"),
      changed: z.boolean(),
      resource: resourceCommandResourceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_user_evaluation"),
      changed: z.boolean(),
      resourceId: z.number().int().positive(),
      evaluation: resourceUserEvaluationSchema.nullable(),
      provenance: resourceCommandProvenanceSchema.nullable(),
      updatedAt: z.string().datetime(),
    })
    .strict(),
]);

export type ResourceCommandResult = z.infer<
  typeof resourceCommandResultSchema
>;

export const resourceCommandReceiptSchema = z
  .object({
    idempotencyKey: resourceCommandIdempotencyKeySchema,
    commandKind: z.enum([
      "create",
      "set_aliases",
      "apply_override",
      "merge",
      "split",
      "rename",
      "set_user_evaluation",
    ]),
    requestFingerprint: z.string().trim().min(1),
    result: resourceCommandResultSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.commandKind !== receipt.result.kind) {
      context.addIssue({
        code: "custom",
        message: "Receipt command kind must match its result kind",
        path: ["result", "kind"],
      });
    }
  });

export type ResourceCommandReceipt = z.infer<
  typeof resourceCommandReceiptSchema
>;

export const duplicateGroupListQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type DuplicateGroupListQuery = z.infer<
  typeof duplicateGroupListQuerySchema
>;

export const duplicateGroupBulkQuerySchema = duplicateGroupListQuerySchema.pick({
  browser: true,
  q: true,
});

export type DuplicateGroupBulkQuery = z.infer<
  typeof duplicateGroupBulkQuerySchema
>;

export const duplicateGroupSchema = z.object({
  installationId: z.string().min(1),
  browser: browserIdentifierSchema,
  url: z.string().trim().min(1),
  count: z.number().int().min(2),
  keeperInstanceId: z.number().int().positive(),
  candidateInstanceIds: z.array(z.number().int().positive()),
  protectedInstanceIds: z.array(z.number().int().positive()),
  instances: z.array(tabInstanceSchema).min(2),
});

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

export const duplicateGroupListResponseSchema = z.object({
  items: z.array(duplicateGroupSchema),
  totalGroups: z.number().int().nonnegative(),
  totalTabsInGroups: z.number().int().nonnegative(),
  totalDuplicateCopies: z.number().int().nonnegative(),
  totalCloseCandidates: z.number().int().nonnegative(),
  totalProtected: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type DuplicateGroupListResponse = z.infer<
  typeof duplicateGroupListResponseSchema
>;

export const duplicateGroupBulkResponseSchema =
  duplicateGroupListResponseSchema.omit({
    page: true,
    pageSize: true,
  });

export type DuplicateGroupBulkResponse = z.infer<
  typeof duplicateGroupBulkResponseSchema
>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  schemaVersion: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const featureFlagsResponseSchema = z.strictObject({
  context: z.boolean(),
  logicalImportance: z.boolean(),
  liveAcquisition: z.boolean().optional(),
  resources: z.boolean().optional(),
  activityWindows: z.boolean().optional(),
  agentUserImportance: z.boolean().optional(),
  pageSummaryCapture: z.boolean().optional(),
  priorityAssessmentWriter: z.boolean().optional(),
  priorityPersonalization: z.boolean().optional(),
  priorityReaders: z.boolean().optional(),
  priorityShadow: z.boolean().optional(),
  privacyPurge: z.boolean().optional(),
  research: z.boolean().optional(),
});

export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;

export const tabCommandRelayLegacyProtocolVersion = 3 as const;
export const tabCommandRelayPreviousProtocolVersion = 4 as const;
export const tabCommandRelayProtocolVersion = 5 as const;
export const exactSingleCloseMinProtocolVersion = 4 as const;
export const exactCaptureMinProtocolVersion = 5 as const;

export function supportsExactSingleClose(protocolVersion: number): boolean {
  return protocolVersion >= exactSingleCloseMinProtocolVersion;
}

export function supportsExactCapture(protocolVersion: number): boolean {
  return protocolVersion >= exactCaptureMinProtocolVersion;
}

export const tabCommandRelayCompatibleProtocolVersionSchema = z.union([
  z.literal(tabCommandRelayLegacyProtocolVersion),
  z.literal(tabCommandRelayPreviousProtocolVersion),
  z.literal(tabCommandRelayProtocolVersion),
]);

export type TabCommandRelayCompatibleProtocolVersion = z.infer<
  typeof tabCommandRelayCompatibleProtocolVersionSchema
>;

const tabCommandRelayKnownBrowserSchema = z.enum(knownBrowserOptions);
export const tabCommandRelayRequestIdSchema = z.string().uuid();
const tabCommandRelayOpaqueIdSchema = z.string().uuid();
const tabCommandRelayTimestampSchema = z.string().datetime();

export const tabCommandScopeSchema = z
  .object({
    browser: tabCommandRelayKnownBrowserSchema,
    browserSessionId: browserSessionIdSchema,
    installationId: installationIdSchema,
  })
  .strict();

export type TabCommandScope = z.infer<typeof tabCommandScopeSchema>;

export const tabCommandRelayPhysicalTargetSchema = z
  .object({
    expectedUrl: tabUrlSchema,
    tabId: z.number().int().nonnegative(),
  })
  .strict();

export type TabCommandRelayPhysicalTarget = z.infer<
  typeof tabCommandRelayPhysicalTargetSchema
>;

export const tabCommandRelayCaptureTargetSchema = z
  .object({
    instanceId: z.number().int().positive(),
    tabId: z.number().int().nonnegative(),
    expectedUrl: tabUrlSchema,
    expectedInstanceRevision: z.number().int().positive(),
    expectedFirstSeenAt: z.string().datetime(),
  })
  .strict();

export type TabCommandRelayCaptureTarget = z.infer<
  typeof tabCommandRelayCaptureTargetSchema
>;

export const exactInstanceCaptureFailureCodeSchema = z.enum([
  "CAPTURE_INSTANCE_MISSING",
  "CAPTURE_SCOPE_MISMATCH",
  "CAPTURE_TAB_CLOSED",
  "CAPTURE_TAB_NAVIGATED",
  "CAPTURE_INSTANCE_STALE",
  "CAPTURE_PAGE_UNSUPPORTED",
  "CAPTURE_EXTRACTION_FAILED",
  "CAPTURE_INGEST_UNAVAILABLE",
  "CAPTURE_INGEST_REJECTED",
  "CAPTURE_COMMAND_NOT_ACTIVE",
  "CAPTURE_COMMAND_MISMATCH",
]);

export type ExactInstanceCaptureFailureCode = z.infer<
  typeof exactInstanceCaptureFailureCodeSchema
>;

export const exactInstanceCaptureFailureSchema = z
  .object({
    code: exactInstanceCaptureFailureCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    observedUrl: tabUrlSchema.optional(),
    recoverable: z.literal(true),
  })
  .strict();

export type ExactInstanceCaptureFailure = z.infer<
  typeof exactInstanceCaptureFailureSchema
>;

export const exactInstanceCaptureReceiptSchema = z
  .object({
    instanceId: z.number().int().positive(),
    browserTabId: z.number().int().nonnegative(),
    canonicalTabId: tabIdSchema,
    logicalPageId: logicalPageIdSchema,
    capturedUrl: tabUrlSchema,
    instanceRevision: z.number().int().positive(),
    firstSeenAt: z.string().datetime(),
    contentRevision: z.number().int().positive(),
    extractedAt: z.string().datetime(),
  })
  .strict();

export type ExactInstanceCaptureReceipt = z.infer<
  typeof exactInstanceCaptureReceiptSchema
>;

export const exactInstanceContentIngestSchema = tabCommandScopeSchema
  .extend({
    commandRequestId: tabCommandRelayRequestIdSchema,
    target: tabCommandRelayCaptureTargetSchema,
    observedUrl: tabUrlSchema,
    text: ingestContentSchema.shape.text,
    htmlExcerpt: ingestContentSchema.shape.htmlExcerpt,
  })
  .strict();

export type ExactInstanceContentIngest = z.infer<
  typeof exactInstanceContentIngestSchema
>;

export const exactInstanceContentIngestResponseSchema =
  exactInstanceCaptureReceiptSchema;

export type ExactInstanceContentIngestResponse = z.infer<
  typeof exactInstanceContentIngestResponseSchema
>;

export const exactInstanceContentIngestErrorSchema = z
  .object({
    error: exactInstanceCaptureFailureCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    observedUrl: tabUrlSchema.optional(),
    recoverable: z.literal(true),
  })
  .strict();

export type ExactInstanceContentIngestError = z.infer<
  typeof exactInstanceContentIngestErrorSchema
>;

const tabCommandRelayPhysicalTargetsSchema = z
  .array(tabCommandRelayPhysicalTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const targetIds = new Set<number>();
    targets.forEach((target, index) => {
      if (targetIds.has(target.tabId)) {
        context.addIssue({
          code: "custom",
          message: "Physical tab target IDs must be unique",
          path: [index, "tabId"],
        });
      }
      targetIds.add(target.tabId);
    });
  });

const tabCommandRelayMoveDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new-window") }).strict(),
  z
    .object({
      kind: z.literal("window"),
      windowId: z.number().int().nonnegative(),
    })
    .strict(),
]);

const tabCommandRelayWorkspaceDestinationSchema = z
  .object({ kind: z.literal("new-window") })
  .strict();

const tabCommandRelayWorkspaceTabSchema = z
  .object({
    muted: z.boolean(),
    pinned: z.boolean(),
    url: tabUrlSchema,
  })
  .strict();

export const tabCommandRelayClosePreviewTargetSchema =
  tabCommandRelayPhysicalTargetSchema
    .extend({
      keeper: tabCommandRelayPhysicalTargetSchema.optional(),
    })
    .strict();

export type TabCommandRelayClosePreviewTarget = z.infer<
  typeof tabCommandRelayClosePreviewTargetSchema
>;

export const tabCommandRelayClosePreviewTargetsSchema = z
  .array(tabCommandRelayClosePreviewTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const targetIds = new Set<number>();
    targets.forEach((target, index) => {
      if (targetIds.has(target.tabId)) {
        context.addIssue({
          code: "custom",
          message: "Close-preview target IDs must be unique",
          path: [index, "tabId"],
        });
      }
      targetIds.add(target.tabId);
      if (
        target.keeper !== undefined &&
        target.keeper.expectedUrl !== target.expectedUrl
      ) {
        context.addIssue({
          code: "custom",
          message: "A keeper must still have the candidate's exact URL",
          path: [index, "keeper", "expectedUrl"],
        });
      }
    });
    targets.forEach((target, index) => {
      if (
        target.keeper !== undefined &&
        targetIds.has(target.keeper.tabId)
      ) {
        context.addIssue({
          code: "custom",
          message: "A keeper cannot also be a close-preview target",
          path: [index, "keeper", "tabId"],
        });
      }
    });
  });

export const tabCommandRelayClosePreviewIntentSchema =
  z.literal("explicit-single");

export type TabCommandRelayClosePreviewIntent = z.infer<
  typeof tabCommandRelayClosePreviewIntentSchema
>;

export const tabCommandRelayCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get-browser-state") }).strict(),
  z
    .object({
      kind: z.literal("capture-tab-content"),
      target: tabCommandRelayCaptureTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("activate-tab"),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      intent: tabCommandRelayClosePreviewIntentSchema.optional(),
      kind: z.literal("close-preview"),
      targets: tabCommandRelayClosePreviewTargetsSchema,
    })
    .strict()
    .superRefine((command, context) => {
      if (
        command.intent === "explicit-single" &&
        command.targets.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "An explicit single close must target exactly one tab",
          path: ["targets"],
        });
      }
    }),
  z
    .object({
      confirmed: z.literal(true),
      kind: z.literal("close"),
      previewId: tabCommandRelayOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("undo-close"),
      undoId: tabCommandRelayOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-pinned"),
      targets: tabCommandRelayPhysicalTargetsSchema,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-muted"),
      targets: tabCommandRelayPhysicalTargetsSchema,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("discard"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      bypassCache: z.boolean().optional(),
      kind: z.literal("reload"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      destination: tabCommandRelayMoveDestinationSchema,
      kind: z.literal("move"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      destination: tabCommandRelayWorkspaceDestinationSchema,
      kind: z.literal("open-workspace"),
      tabs: z.array(tabCommandRelayWorkspaceTabSchema).min(1),
    })
    .strict(),
]);

export type TabCommandRelayCommand = z.infer<
  typeof tabCommandRelayCommandSchema
>;

const tabCommandRelaySkippedSchema = z
  .object({
    reason: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayFailureSchema = z
  .object({
    error: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayUndoSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    undoId: tabCommandRelayOpaqueIdSchema,
  })
  .strict();

const tabCommandRelayWindowSummarySchema = z
  .object({
    focused: z.boolean(),
    tabCount: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayMutationResultFields = {
  failed: z.array(tabCommandRelayFailureSchema),
  requested: z.number().int().nonnegative(),
  skipped: z.array(tabCommandRelaySkippedSchema),
  succeededTabIds: z.array(z.number().int().nonnegative()),
} as const;

const tabCommandRelayWindowBoundsSchema = z
  .object({
    height: z.number().int().positive(),
    left: z.number().int(),
    top: z.number().int(),
    width: z.number().int().positive(),
  })
  .strict();

export const tabCommandRelayResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("get-browser-state"),
      pendingUndos: z.array(tabCommandRelayUndoSummarySchema).max(5),
      windows: z.array(tabCommandRelayWindowSummarySchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("capture-tab-content"),
      target: tabCommandRelayCaptureTargetSchema,
      outcome: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("captured"),
            receipt: exactInstanceCaptureReceiptSchema,
          })
          .strict(),
        z
          .object({
            status: z.literal("failed"),
            failure: exactInstanceCaptureFailureSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("activate-tab"),
      tabId: z.number().int().nonnegative(),
      windowBounds: tabCommandRelayWindowBoundsSchema.optional(),
      windowId: z.number().int().nonnegative(),
      windowTitle: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      candidateTabIds: z.array(z.number().int().nonnegative()),
      expiresAt: z.number().int().nonnegative(),
      kind: z.literal("close-preview"),
      previewId: tabCommandRelayOpaqueIdSchema,
      requested: z.number().int().nonnegative(),
      skipped: z.array(tabCommandRelaySkippedSchema),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("close"),
      undo: tabCommandRelayUndoSummarySchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      failed: z.array(tabCommandRelayFailureSchema),
      kind: z.literal("undo-close"),
      requested: z.number().int().nonnegative(),
      restoredTabIds: z.array(z.number().int().nonnegative()),
      retry: tabCommandRelayUndoSummarySchema.optional(),
      skipped: z.array(tabCommandRelaySkippedSchema),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("set-pinned"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("set-muted"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("discard"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("reload"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      destinationWindowId: z.number().int().nonnegative().optional(),
      kind: z.literal("move"),
    })
    .strict(),
  z
    .object({
      destinationWindowId: z.number().int().nonnegative().optional(),
      failed: z.array(
        z
          .object({
            error: z.string().min(1),
            index: z.number().int().nonnegative(),
          })
          .strict(),
      ),
      kind: z.literal("open-workspace"),
      openedTabIds: z.array(z.number().int().nonnegative()),
      requested: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type TabCommandRelayResult = z.infer<
  typeof tabCommandRelayResultSchema
>;

export const tabCommandRelayHttpRequestSchema = tabCommandScopeSchema
  .extend({ command: tabCommandRelayCommandSchema })
  .strict();

export type TabCommandRelayHttpRequest = z.infer<
  typeof tabCommandRelayHttpRequestSchema
>;

export const tabCommandRelayConnectedScopeSchema = tabCommandScopeSchema
  .extend({
    connectedAt: tabCommandRelayTimestampSchema,
    lastSeenAt: tabCommandRelayTimestampSchema,
    protocolVersion: tabCommandRelayCompatibleProtocolVersionSchema,
  })
  .strict();

export type TabCommandRelayConnectedScope = z.infer<
  typeof tabCommandRelayConnectedScopeSchema
>;

export const tabCommandRelayConnectedScopesResponseSchema = z
  .object({ items: z.array(tabCommandRelayConnectedScopeSchema) })
  .strict();

export type TabCommandRelayConnectedScopesResponse = z.infer<
  typeof tabCommandRelayConnectedScopesResponseSchema
>;

export const tabCommandRelayRegisterEnvelopeSchema = z
  .object({
    scope: tabCommandScopeSchema,
    type: z.literal("register"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayReadyEnvelopeSchema = z
  .object({
    connectedAt: tabCommandRelayTimestampSchema,
    heartbeatIntervalMs: z.number().int().positive(),
    scope: tabCommandScopeSchema,
    type: z.literal("ready"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayPingEnvelopeSchema = z
  .object({
    heartbeatId: tabCommandRelayRequestIdSchema,
    sentAt: tabCommandRelayTimestampSchema,
    type: z.literal("ping"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayPongEnvelopeSchema = z
  .object({
    heartbeatId: tabCommandRelayRequestIdSchema,
    type: z.literal("pong"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayCommandEnvelopeSchema = z
  .object({
    command: tabCommandRelayCommandSchema,
    executionDeadlineAt: z.number().int().nonnegative(),
    requestId: tabCommandRelayRequestIdSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("command"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

const tabCommandRelaySuccessfulResultEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    requestId: tabCommandRelayRequestIdSchema,
    result: tabCommandRelayResultSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("result"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

const tabCommandRelayFailedResultEnvelopeSchema = z
  .object({
    error: z.string().min(1),
    ok: z.literal(false),
    requestId: tabCommandRelayRequestIdSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("result"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayResultEnvelopeSchema = z.union([
  tabCommandRelaySuccessfulResultEnvelopeSchema,
  tabCommandRelayFailedResultEnvelopeSchema,
]);

export const tabCommandRelayClientEnvelopeSchema = z.union([
  tabCommandRelayRegisterEnvelopeSchema,
  tabCommandRelayPongEnvelopeSchema,
  tabCommandRelayResultEnvelopeSchema,
]);

export type TabCommandRelayClientEnvelope = z.infer<
  typeof tabCommandRelayClientEnvelopeSchema
>;

export const tabCommandRelayServerEnvelopeSchema = z.union([
  tabCommandRelayReadyEnvelopeSchema,
  tabCommandRelayPingEnvelopeSchema,
  tabCommandRelayCommandEnvelopeSchema,
]);

export type TabCommandRelayServerEnvelope = z.infer<
  typeof tabCommandRelayServerEnvelopeSchema
>;

export const tabCommandRelayErrorCodeSchema = z.enum([
  "SCOPE_OFFLINE",
  "EXTENSION_PROTOCOL_UNSUPPORTED",
  "PAGE_SUMMARY_CAPTURE_UNAVAILABLE",
  "COMMAND_TIMEOUT",
  "EXTENSION_DISCONNECTED",
  "EXTENSION_COMMAND_FAILED",
  "INVALID_COMMAND_RECEIPT",
  "FOREGROUND_HANDOFF_FAILED",
]);

export type TabCommandRelayErrorCode = z.infer<
  typeof tabCommandRelayErrorCodeSchema
>;

const tabCommandRelayHttpSuccessSchema = z
  .object({
    ok: z.literal(true),
    requestId: tabCommandRelayRequestIdSchema,
    result: tabCommandRelayResultSchema,
    scope: tabCommandScopeSchema,
  })
  .strict();

const tabCommandRelayHttpFailureSchema = z
  .object({
    error: tabCommandRelayErrorCodeSchema,
    message: z.string().min(1),
    ok: z.literal(false),
    outcome: z.enum(["not-sent", "unknown"]),
    requestId: tabCommandRelayRequestIdSchema.optional(),
  })
  .strict();

export const tabCommandRelayHttpResponseSchema = z.union([
  tabCommandRelayHttpSuccessSchema,
  tabCommandRelayHttpFailureSchema,
]);

export type TabCommandRelayHttpResponse = z.infer<
  typeof tabCommandRelayHttpResponseSchema
>;
