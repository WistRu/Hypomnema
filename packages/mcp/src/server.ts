import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import {
  agentResearchCancelRequestSchema,
  agentResearchReportDetailSchema,
  agentResearchStartRequestSchema,
  agentResearchStartResponseSchema,
  agentPriorityFeedbackRequestSchema,
  agentPriorityRecomputeRequestSchema,
  agentUserImportanceRequestSchema,
  agentUserImportanceResponseSchema,
  browserSessionIdSchema,
  activityWindowSchema,
  contextEntryKindSchema,
  durableJobIdSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  installationIdSchema,
  logicalPageIdSchema,
  priorityFeedbackReceiptSchema,
  prioritySafeReadSchema,
  prioritySubjectSchema,
  researchJobIdSchema,
  researchReportListResponseSchema,
  resourceAccessClassSchema,
  resourceKindSchema,
  resourceLifecycleStateSchema,
  resourceActivityResponseSchema,
  tagPathSchema,
  tabUrlSchema,
  type AgentContextAppendCommand,
  type AgentSessionIntentSetCommand,
  type FeatureFlagsResponse,
  type AgentUserImportanceResponse,
  type PrioritySubjectContract,
  type ResearchReportListQuery,
  type ResearchTarget,
  type ResourceDetail,
  type ResourceListResponse,
  type ResourceSummary,
  type ShareableContextBundle,
  type ShareableContextEntry,
  type SummaryJob,
  type TabDetailResponse,
} from "@tabhub/shared";
import * as z from "zod/v4";

import type {
  ListResourcesInput,
  ListTabsInput,
  TabHubApi,
} from "./tabhub-api.js";
import {
  parseMcpPriorityFeedbackReceipt,
  parseMcpPrioritySafeRead,
} from "./priority-projection.js";

export type {
  AgentContextMutationReceipt,
  AgentSessionIntentMutationReceipt,
  ListResourcesInput,
  ListTabsInput,
  TabHubApi,
} from "./tabhub-api.js";

const tabStatusInputSchema = z.enum([
  "inbox",
  "in_progress",
  "done",
  "archived",
]);
const tabImportanceInputSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const searchModeInputSchema = z.enum(["fulltext", "semantic"]);

const listTabsInputSchema = z
  .object({
    browser: z.string().trim().min(1).max(64).optional(),
    status: tabStatusInputSchema.optional(),
    importance: tabImportanceInputSchema.optional(),
    is_open: z.boolean().optional(),
    tag: tagPathSchema.optional(),
    q: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("A full-text or semantic query; cannot be combined with similar_to.")
      .optional(),
    search_mode: searchModeInputSchema
      .describe(
        "How to interpret q; semantic mode requires either q or similar_to.",
      )
      .optional(),
    similar_to: z
      .number()
      .int()
      .positive()
      .describe(
        "Find tabs similar to this positive TabHub tab ID; cannot be combined with q.",
      )
      .optional(),
    page: z.number().int().positive().default(1),
    page_size: z.number().int().positive().max(200).default(50),
  })
  .superRefine((input, context) => {
    if (input.q !== undefined && input.similar_to !== undefined) {
      context.addIssue({
        code: "custom",
        message: "q and similar_to cannot be combined",
      });
    }

    if (
      input.search_mode === "semantic" &&
      input.q === undefined &&
      input.similar_to === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Semantic search requires q or similar_to",
      });
    }
  });

const getTabInputSchema = z.object({
  id: z.number().int().positive(),
  include_content: z.boolean().default(false),
});

const searchTabsInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: searchModeInputSchema.default("fulltext"),
  browser: z.string().trim().min(1).max(64).optional(),
  status: tabStatusInputSchema.optional(),
  importance: tabImportanceInputSchema.optional(),
  is_open: z.boolean().optional(),
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const tabIdsInputSchema = z.array(z.number().int().positive()).min(1);

const setStatusInputSchema = z.object({
  ids: tabIdsInputSchema,
  status: tabStatusInputSchema,
});

const setImportanceInputSchema = z.object({
  ids: tabIdsInputSchema.describe(
    "TabHub tab IDs named by the user's explicit command.",
  ),
  level: tabImportanceInputSchema.describe(
    "The personal importance level explicitly chosen by the user; 0 clears it.",
  ),
}).strict();

const tagTabsInputSchema = z.object({
  ids: tabIdsInputSchema,
  tag_path: tagPathSchema,
});

const linkTabsInputSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  kind: z.string().trim().min(1).max(128).default("related"),
  note: z.string().max(10_000).optional(),
});

const summarizeTabInputSchema = z.object({
  id: z.number().int().positive(),
  depth: z.enum(["short", "deep"]),
});

const clusterInboxInputSchema = z.object({
  max_clusters: z.number().int().min(1).max(50).default(8),
});

const retentionPageInputSchema = z.object({
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const setPageRetentionInputSchema = z.object({
  id: z.number().int().positive(),
  decision: z.enum(["keep", "later"]),
});

const closeAndForgetPageInputSchema = z.object({
  id: z.number().int().positive(),
  confirmed: z
    .literal(true)
    .describe("Must be true only after the user explicitly confirms closure."),
});

const restoreRetentionPageInputSchema = z.object({
  id: z.number().int().positive(),
});

const logicalPageInputSchema = z
  .object({ logical_page_id: logicalPageIdSchema })
  .strict();

const resourceInputSchema = z
  .object({ resource_id: z.number().int().positive() })
  .strict();

const prioritySubjectInputShape = {
  subject_type: z.enum(["page", "resource"]).describe(
    "The strict priority subject type; use logical_page_id for page or resource_id for resource.",
  ),
  logical_page_id: logicalPageIdSchema.optional(),
  resource_id: z.number().int().positive().optional(),
};

function validatePrioritySubjectInput(
  input: {
    subject_type: "page" | "resource";
    logical_page_id?: number | undefined;
    resource_id?: number | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  if (input.subject_type === "page") {
    if (input.logical_page_id === undefined) {
      context.addIssue({
        code: "custom",
        message: "Page priority subject requires logical_page_id",
        path: ["logical_page_id"],
        input,
      });
    }
    if (input.resource_id !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Page priority subject cannot include resource_id",
        path: ["resource_id"],
        input,
      });
    }
    return;
  }
  if (input.resource_id === undefined) {
    context.addIssue({
      code: "custom",
      message: "Resource priority subject requires resource_id",
      path: ["resource_id"],
      input,
    });
  }
  if (input.logical_page_id !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Resource priority subject cannot include logical_page_id",
      path: ["logical_page_id"],
      input,
    });
  }
}

const explainPriorityInputSchema = z
  .object(prioritySubjectInputShape)
  .strict()
  .superRefine(validatePrioritySubjectInput);

const recordPriorityFeedbackInputSchema = z
  .object({
    ...prioritySubjectInputShape,
    assessment_id: z.number().int().positive(),
    verdict: z.enum(["accept", "reject", "too_high", "too_low"]),
    note: z.string().trim().min(1).max(4_096).optional(),
    idempotency_key: z.string().trim().min(1).max(200).describe(
      "Stable replay key for this exact user-authorized feedback command.",
    ),
    authorization_ref: z.string().trim().min(1).max(256).describe(
      "Reference to the explicit user instruction authorizing this feedback.",
    ),
    supersedes_id: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine(validatePrioritySubjectInput);

const recomputePriorityInputSchema = z
  .object({
    subject_type: z.enum(["page", "resource", "collection"]).default("collection"),
    logical_page_id: logicalPageIdSchema.optional(),
    resource_id: z.number().int().positive().optional(),
    idempotency_key: z.string().trim().min(1).max(200).describe(
      "Stable replay key for this exact user-authorized recompute request.",
    ),
    authorization_ref: z.string().trim().min(1).max(256).describe(
      "Reference to the explicit user instruction authorizing this recompute.",
    ),
    step_batch_size: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.subject_type === "collection") {
      if (input.logical_page_id !== undefined || input.resource_id !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Collection priority subject cannot include a page or resource ID",
          path: input.logical_page_id !== undefined
            ? ["logical_page_id"]
            : ["resource_id"],
          input,
        });
      }
      return;
    }
    validatePrioritySubjectInput({
      subject_type: input.subject_type,
      logical_page_id: input.logical_page_id,
      resource_id: input.resource_id,
    }, context);
  });

const priorityAssessmentJobIdSchema = durableJobIdSchema.refine(
  (value) => value.startsWith("priority_assessment:"),
  { message: "Expected a priority assessment job ID" },
);

const getJobStatusInputSchema = z.object({
  id: priorityAssessmentJobIdSchema,
}).strict();

const researchDigestInputSchema = z.string().regex(/^[0-9a-f]{64}$/);
const researchDigestSetInputSchema = z.array(researchDigestInputSchema).max(10_000)
  .superRefine((value, context) => {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index - 1]! >= value[index]!) {
        context.addIssue({
          code: "custom",
          message: "Origin digests must be unique and canonically sorted",
          input: value,
        });
        return;
      }
    }
  });

const researchStartTargetInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page"),
    logical_page_id: logicalPageIdSchema,
  }).strict(),
  z.object({
    type: z.literal("resource"),
    resource_id: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("selection"),
    logical_page_ids: z.array(logicalPageIdSchema).min(1).max(100),
    fingerprint: researchDigestInputSchema,
  }).strict().superRefine((value, context) => {
    if (new Set(value.logical_page_ids).size !== value.logical_page_ids.length) {
      context.addIssue({
        code: "custom",
        message: "Selection pages must be unique",
        input: value,
      });
    }
  }),
]);

const researchListTargetInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page"),
    logical_page_id: logicalPageIdSchema,
  }).strict(),
  z.object({
    type: z.literal("resource"),
    resource_id: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("selection"),
    fingerprint: researchDigestInputSchema,
  }).strict(),
]);

const researchBudgetInputSchema = z.object({
  max_steps: z.number().int().positive().max(100),
  max_tokens: z.number().int().nonnegative().max(200_000),
  max_cost_usd: z.number().finite().nonnegative().max(2),
  max_wall_time_ms: z.number().int().positive().max(1_800_000),
}).strict();

const strictBoundedResearchText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim(), {
    message: "Value must not have surrounding whitespace",
  });

const researchConfirmedOriginsInputSchema = z.object({
  authenticated_origin_digests: researchDigestSetInputSchema,
  sensitive_origin_digests: researchDigestSetInputSchema,
}).strict();

const startResearchInputSchema = z.object({
  target: researchStartTargetInputSchema,
  question: strictBoundedResearchText(4_000),
  include_shareable_context: z.boolean(),
  max_included_sources: z.number().int().positive().max(100),
  budget: researchBudgetInputSchema,
  confirmed_origins: researchConfirmedOriginsInputSchema.optional().default({
    authenticated_origin_digests: [],
    sensitive_origin_digests: [],
  }),
  idempotency_key: strictBoundedResearchText(200).describe(
    "Stable replay key for this exact user-authorized research request.",
  ),
  authorization_ref: strictBoundedResearchText(256).describe(
    "Reference to the explicit user instruction authorizing this research run.",
  ),
}).strict();

const getAiJobInputSchema = z.object({ id: researchJobIdSchema }).strict();

const cancelAiJobInputSchema = z.object({
  id: researchJobIdSchema,
  idempotency_key: strictBoundedResearchText(200),
  authorization_ref: strictBoundedResearchText(256),
}).strict();

const listResearchReportsInputSchema = z.object({
  target: researchListTargetInputSchema,
  limit: z.number().int().positive().max(100).default(50),
  before_version: z.number().int().positive().optional(),
}).strict();

const getResearchReportInputSchema = z.object({
  id: z.number().int().positive(),
}).strict();

const agentPriorityFeedbackCommandSchema = agentPriorityFeedbackRequestSchema
  .extend({ subject: prioritySubjectSchema })
  .strict();

const setUserImportanceInputSchema = z
  .object({
    ...prioritySubjectInputShape,
    value: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable()
      .describe(
        "The personal importance explicitly chosen by the user: 1, 2, 3, or null to clear it.",
      ),
    idempotency_key: z.string().trim().min(1).max(200).describe(
      "Stable replay key for this exact user-authorized importance command.",
    ),
    authorization_ref: z.string().trim().min(1).max(256).describe(
      "Reference to the explicit user instruction authorizing this change.",
    ),
  })
  .strict()
  .superRefine(validatePrioritySubjectInput);

const resourceActivityInputSchema = resourceInputSchema
  .extend({ window: activityWindowSchema.default("all") })
  .strict();

const listResourcesInputSchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    kind: resourceKindSchema.optional(),
    access_class: resourceAccessClassSchema.optional(),
    lifecycle_state: resourceLifecycleStateSchema.default("active"),
    browser: z.string().trim().min(1).max(64).optional(),
    status: tabStatusInputSchema.optional(),
    importance: tabImportanceInputSchema.optional(),
    tag: tagPathSchema.optional(),
    page: z.number().int().positive().default(1),
    page_size: z.number().int().positive().max(200).default(50),
    sort_by: z
      .enum(["name", "logical_pages", "activity", "updated_at"])
      .default("name"),
    sort_direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

const searchPageContextInputSchema = logicalPageInputSchema
  .extend({
    query: z.string().trim().min(1).max(4_096),
    limit: z.number().int().positive().max(200).default(50),
  })
  .strict();

const modelInputSchema = z
  .object({
    provider: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    prompt_version: z.string().trim().min(1).max(128),
  })
  .strict();

const contextWriteProvenanceInputSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("on_behalf_of_user") }).strict(),
  z
    .object({
      method: z.literal("model"),
      source_fingerprint: z.string().trim().min(1).max(512),
      model: modelInputSchema,
      confidence: z.number().finite().min(0).max(1).optional(),
    })
    .strict(),
]);

const setPageContextInputSchema = logicalPageInputSchema
  .extend({
    entry_kind: contextEntryKindSchema,
    body: z.string().trim().min(1).max(100_000),
    stale_at: z.string().datetime().nullable().optional(),
    idempotency_key: z.string().trim().min(1).max(256),
    provenance: contextWriteProvenanceInputSchema.default({
      method: "on_behalf_of_user",
    }),
  })
  .strict();

const setResourceContextInputSchema = resourceInputSchema
  .extend({
    entry_kind: contextEntryKindSchema,
    body: z.string().trim().min(1).max(100_000),
    stale_at: z.string().datetime().nullable().optional(),
    idempotency_key: z.string().trim().min(1).max(256),
    provenance: contextWriteProvenanceInputSchema.default({
      method: "on_behalf_of_user",
    }),
  })
  .strict();

const setResourceEvaluationInputSchema = resourceInputSchema
  .extend({
    evaluation: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    idempotency_key: z.string().trim().min(1).max(200),
    authorization_ref: z.string().trim().min(1).max(256).describe(
      "Reference to the explicit user instruction authorizing this evaluation.",
    ),
  })
  .strict();

const exactTabScopeInputSchema = z
  .object({
    installation_id: installationIdSchema,
    browser_session_id: browserSessionIdSchema,
    browser_tab_id: z.number().int().nonnegative(),
  })
  .strict();

const setTabSessionIntentInputSchema = exactTabScopeInputSchema
  .extend({
    expected_url: tabUrlSchema,
    body: z.string().trim().min(1).max(100_000),
    stale_at: z.string().datetime().nullable().optional(),
    idempotency_key: z.string().trim().min(1).max(256),
    provenance: contextWriteProvenanceInputSchema.default({
      method: "on_behalf_of_user",
    }),
  })
  .strict();

const emptyInputSchema = z.object({});

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
} as const;

const openWorldReadOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const summaryMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const createMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const destructiveMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const researchStartMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const researchCancelMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const capturedTextLimit = 20_000;
const resourceAliasLimit = 50;
const resourceTopicPathLimit = 50;
const resourceContextEntryLimit = 20;
const resourceContextBodyLimit = 4_000;
const defaultSummaryPollIntervalMs = 250;
const defaultSummaryPollTimeoutMs = 55_000;

export interface McpServerOptions {
  features?: FeatureFlagsResponse;
  summaryPollIntervalMs?: number;
  summaryPollTimeoutMs?: number;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          error instanceof Error
            ? error.message
            : "The TabHub operation failed unexpectedly",
      },
    ],
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

async function runStructuredTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
) {
  try {
    const value = await operation();
    return {
      ...jsonResult(value),
      structuredContent: value,
    };
  } catch (error) {
    return errorResult(error);
  }
}

function isPendingSummaryJob(job: SummaryJob): boolean {
  return job.status === "queued" || job.status === "running";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type TimedResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);

    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function pollSummaryJob(
  api: TabHubApi,
  jobId: number,
  intervalMs: number,
  timeoutMs: number,
): Promise<SummaryJob> {
  const deadline = Date.now() + timeoutMs;
  let job = await api.getSummaryJob(jobId);

  while (isPendingSummaryJob(job)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return job;
    }

    await delay(Math.min(intervalMs, remainingMs));
    const requestTimeMs = deadline - Date.now();
    if (requestTimeMs <= 0) {
      return job;
    }

    const next = await settleWithin(api.getSummaryJob(jobId), requestTimeMs);
    if (next.timedOut) {
      return job;
    }

    job = next.value;
  }

  return job;
}

function truncateCapturedText(text: string): string {
  if (text.length <= capturedTextLimit) {
    return text;
  }

  return `${text.slice(0, capturedTextLimit)}\n\n[Captured text truncated]`;
}

function boundedText(text: string, limit: number): {
  text: string;
  truncated: boolean;
} {
  return text.length <= limit
    ? { text, truncated: false }
    : { text: text.slice(0, limit), truncated: true };
}

function formatTabForTool(tab: TabDetailResponse, includeContent: boolean) {
  return {
    ...tab,
    content:
      tab.content === null
        ? null
        : {
            ...(includeContent && tab.content.text !== null
              ? { text: truncateCapturedText(tab.content.text) }
              : {}),
            summary: tab.content.summary,
            summaryModel: tab.content.summaryModel,
            extractedAt: tab.content.extractedAt,
          },
  };
}

function formatTabResource(tab: TabDetailResponse): string {
  const title = tab.title?.trim() || tab.url;
  const tags = tab.tags.map((tag) => tag.path).join(", ") || "None";
  const summary = tab.content?.summary?.trim() || "No summary captured.";
  const capturedText =
    tab.content?.text === null || tab.content?.text === undefined
      ? "No page text captured."
      : truncateCapturedText(tab.content.text);

  return [
    `# ${title}`,
    "",
    `- URL: ${tab.url}`,
    `- Tab ID: ${tab.id}`,
    `- Browser: ${tab.browser}`,
    `- Status: ${tab.status}`,
    `- Importance: ${tab.importance}`,
    `- Open: ${tab.isOpen ? "yes" : "no"}`,
    `- Tags: ${tags}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Captured text",
    "",
    capturedText,
  ].join("\n");
}

function formatResourceSummary(resource: ResourceSummary) {
  const topicPaths = resource.topicPaths.slice(0, resourceTopicPathLimit);
  return {
    ...resource,
    topicPaths,
    projection: {
      topicPaths: {
        shareableTotal: resource.topicPaths.length,
        returned: topicPaths.length,
        truncated: topicPaths.length < resource.topicPaths.length,
      },
    },
  };
}

function formatResourceList(resources: ResourceListResponse) {
  return {
    ...resources,
    items: resources.items.map(formatResourceSummary),
  };
}

function formatResourceDetail(resource: ResourceDetail) {
  const aliases = resource.aliases.slice(0, resourceAliasLimit);
  const summary = formatResourceSummary(resource);
  return {
    ...summary,
    aliases,
    projection: {
      ...summary.projection,
      aliases: {
        shareableTotal: resource.aliases.length,
        returned: aliases.length,
        truncated: aliases.length < resource.aliases.length,
      },
    },
  };
}

function formatShareableContextEntry(entry: ShareableContextEntry) {
  const body = boundedText(entry.body, resourceContextBodyLimit);
  return {
    ...entry,
    body: body.text,
    bodyTruncated: body.truncated,
  };
}

function formatShareableResourceContext(context: ShareableContextBundle) {
  const entries = context.entries.slice(-resourceContextEntryLimit);
  const currentEntries = context.currentEntries.slice(0, resourceContextEntryLimit);
  const preview =
    context.preview === null
      ? null
      : (() => {
          const body = boundedText(context.preview.body, resourceContextBodyLimit);
          return {
            ...context.preview,
            body: body.text,
            bodyTruncated: body.truncated,
          };
        })();
  return {
    subject: context.subject,
    entries: entries.map(formatShareableContextEntry),
    currentEntries: currentEntries.map(formatShareableContextEntry),
    preview,
    projection: {
      visibility: "share_with_ai" as const,
      history: {
        shareableTotal: context.entries.length,
        returned: entries.length,
        omittedOlder: context.entries.length - entries.length,
      },
      current: {
        shareableTotal: context.currentEntries.length,
        returned: currentEntries.length,
        truncated: currentEntries.length < context.currentEntries.length,
      },
      bodyCharacterLimit: resourceContextBodyLimit,
    },
  };
}

function formatContextMutationReceipt(
  receipt: Awaited<ReturnType<TabHubApi["setResourceContext"]>>,
) {
  return {
    ...receipt,
    entry: formatShareableContextEntry(receipt.entry),
  };
}

function formatResourceProjection(
  resource: ResourceDetail,
  context: ShareableContextBundle,
) {
  return {
    resource: formatResourceDetail(resource),
    context: formatShareableResourceContext(context),
  };
}

function toListTabsInput(
  input: z.infer<typeof listTabsInputSchema>,
): ListTabsInput {
  return {
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.importance === undefined
      ? {}
      : { importance: input.importance }),
    ...(input.is_open === undefined ? {} : { isOpen: input.is_open }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.q === undefined ? {} : { q: input.q }),
    ...(input.search_mode === undefined
      ? {}
      : { searchMode: input.search_mode }),
    ...(input.similar_to === undefined
      ? {}
      : { similarTo: input.similar_to }),
    page: input.page,
    pageSize: input.page_size,
  };
}

function toListResourcesInput(
  input: z.infer<typeof listResourcesInputSchema>,
): ListResourcesInput {
  return {
    ...(input.q === undefined ? {} : { q: input.q }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.access_class === undefined
      ? {}
      : { accessClass: input.access_class }),
    lifecycleState: input.lifecycle_state,
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.importance === undefined
      ? {}
      : { importance: input.importance }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    page: input.page,
    pageSize: input.page_size,
    sortBy: input.sort_by,
    sortDirection: input.sort_direction,
  };
}

function toAgentProvenance(
  input: z.infer<typeof contextWriteProvenanceInputSchema>,
): AgentContextAppendCommand["provenance"] {
  return input.method === "on_behalf_of_user"
    ? { method: "on_behalf_of_user" }
    : {
        method: "model",
        sourceFingerprint: input.source_fingerprint,
        model: {
          provider: input.model.provider,
          name: input.model.name,
          promptVersion: input.model.prompt_version,
        },
        ...(input.confidence === undefined
          ? {}
          : { confidence: input.confidence }),
      };
}

function toPrioritySubject(input: {
  subject_type: "page" | "resource";
  logical_page_id?: number | undefined;
  resource_id?: number | undefined;
}): PrioritySubjectContract {
  if (input.subject_type === "page" && input.logical_page_id !== undefined) {
    return { type: "page", logicalPageId: input.logical_page_id };
  }
  if (input.subject_type === "resource" && input.resource_id !== undefined) {
    return { type: "resource", resourceId: input.resource_id };
  }
  throw new Error("Invalid priority subject");
}

function toResearchTarget(
  input: z.infer<typeof researchStartTargetInputSchema>,
): ResearchTarget {
  if (input.type === "page") {
    return { type: "page", logicalPageId: input.logical_page_id };
  }
  if (input.type === "resource") {
    return { type: "resource", resourceId: input.resource_id };
  }
  return {
    type: "selection",
    logicalPageIds: input.logical_page_ids,
    fingerprint: input.fingerprint,
  };
}

function toResearchReportListQuery(
  target: z.infer<typeof researchListTargetInputSchema>,
  limit: number,
  beforeVersion: number | undefined,
): ResearchReportListQuery {
  const pagination = {
    limit,
    ...(beforeVersion === undefined ? {} : { beforeVersion }),
  };
  if (target.type === "page") {
    return {
      targetType: "page",
      targetId: target.logical_page_id,
      ...pagination,
    };
  }
  if (target.type === "resource") {
    return {
      targetType: "resource",
      targetId: target.resource_id,
      ...pagination,
    };
  }
  return {
    targetType: "selection",
    targetId: target.fingerprint,
    ...pagination,
  };
}

function parseResearchJobView(
  value: unknown,
  expectedId: string,
) {
  const result = durableJobViewSchema.parse(value);
  if (result.kind !== "resource_research" || result.id !== expectedId) {
    throw new Error("TabHub research job returned a mismatched response");
  }
  return result;
}

export function createMcpServer(
  api: TabHubApi,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "tabhub", version: "0.1.0" });
  const summaryPollIntervalMs =
    options.summaryPollIntervalMs ?? defaultSummaryPollIntervalMs;
  const summaryPollTimeoutMs =
    options.summaryPollTimeoutMs ?? defaultSummaryPollTimeoutMs;
  const contextEnabled = options.features?.context ?? false;
  const resourcesEnabled = options.features?.resources === true;
  const resourceActivityEnabled =
    resourcesEnabled && options.features?.activityWindows === true;
  const priorityReadersEnabled = options.features?.priorityReaders === true;
  const priorityWriterEnabled =
    options.features?.priorityAssessmentWriter === true;
  const userImportanceEnabled =
    options.features?.agentUserImportance === true;
  const researchSupported = options.features?.research !== undefined;
  const researchEnabled = options.features?.research === true;

  if (priorityReadersEnabled) {
    server.registerTool(
      "explain_priority",
      {
        description:
          "Return the safe current priority outcome and current/dirty/review metadata for one strict page or resource subject. It never returns local-only context, hidden counts, raw features, or private-existence signals.",
        inputSchema: explainPriorityInputSchema,
        outputSchema: prioritySafeReadSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => runStructuredTool(async () =>
        parseMcpPrioritySafeRead(
          await api.explainPriority(toPrioritySubject(input)),
        )),
    );
  }

  if (priorityWriterEnabled) {
    server.registerTool(
      "recompute_priority",
      {
        description:
          "Submit one durable priority recompute after an explicit user instruction and immediately return its job reference. The trusted agent route fixes agent/on_behalf_of_user provenance; use get_job_status to observe progress.",
        inputSchema: recomputePriorityInputSchema,
        outputSchema: durableJobRefSchema,
        annotations: mutationAnnotations,
      },
      async ({
        subject_type: subjectType,
        logical_page_id: logicalPageId,
        resource_id: resourceId,
        idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef,
        step_batch_size: stepBatchSize,
      }) => runStructuredTool(async () => durableJobRefSchema.parse(
        await api.recomputePriority(agentPriorityRecomputeRequestSchema.parse({
          ...(subjectType === "page"
            ? { subject: { type: "page", logicalPageId } }
            : subjectType === "resource"
              ? { subject: { type: "resource", resourceId } }
              : {}),
          idempotencyKey,
          authorizationRef,
          stepBatchSize,
        })),
      )),
    );

    server.registerTool(
      "get_job_status",
      {
        description:
          "Read the current status of one durable priority-assessment job by its namespaced priority_assessment ID. This performs one status read and never polls or waits for completion.",
        inputSchema: getJobStatusInputSchema,
        outputSchema: durableJobViewSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ id }) => runStructuredTool(async () =>
        durableJobViewSchema.parse(await api.getJobStatus(id))),
    );

    server.registerTool(
      "record_priority_feedback",
      {
        description:
          "Record feedback on one current page or resource assessment only after an explicit user instruction. The trusted agent route fixes agent/on_behalf_of_user provenance and requires both authorization and idempotent replay references.",
        inputSchema: recordPriorityFeedbackInputSchema,
        outputSchema: priorityFeedbackReceiptSchema,
        annotations: mutationAnnotations,
      },
      async ({
        assessment_id: assessmentId,
        verdict,
        note,
        idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef,
        supersedes_id: supersedesId,
        ...subjectInput
      }) => runStructuredTool(async () =>
        parseMcpPriorityFeedbackReceipt(
          await api.recordPriorityFeedback(
            agentPriorityFeedbackCommandSchema.parse({
              subject: toPrioritySubject(subjectInput),
              assessmentId,
              verdict,
              ...(note === undefined ? {} : { note }),
              idempotencyKey,
              authorizationRef,
              ...(supersedesId === undefined ? {} : { supersedesId }),
            }),
          ),
        )),
    );
  }

  if (researchEnabled) {
    server.registerTool(
      "start_research",
      {
        description:
          "Start or replay one user-authorized research run and immediately returns its durable job reference or exact per-run confirmation requirements. It never fetches, navigates, captures, or polls; it uses only the server-approved captured corpus.",
        inputSchema: startResearchInputSchema,
        outputSchema: agentResearchStartResponseSchema,
        annotations: researchStartMutationAnnotations,
      },
      async ({
        target,
        question,
        include_shareable_context: includeShareableContext,
        max_included_sources: maxIncludedSources,
        budget,
        confirmed_origins: confirmedOrigins,
        idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef,
      }) => runStructuredTool(async () => agentResearchStartResponseSchema.parse(
        await api.startResearch(agentResearchStartRequestSchema.parse({
          version: 1,
          target: toResearchTarget(target),
          question,
          includeShareableContext,
          maxIncludedSources,
          budget: {
            maxSteps: budget.max_steps,
            maxTokens: budget.max_tokens,
            maxCostUsd: budget.max_cost_usd,
            maxWallTimeMs: budget.max_wall_time_ms,
          },
          confirmedOrigins: {
            authenticatedOriginDigests:
              confirmedOrigins.authenticated_origin_digests,
            sensitiveOriginDigests: confirmedOrigins.sensitive_origin_digests,
          },
          idempotencyKey,
          authorizationRef,
        })),
      )),
    );
  }

  if (researchSupported) {
    server.registerTool(
      "get_ai_job",
      {
        description:
          "Read one resource-research durable job by its namespaced ID. This performs one status read and never polls or waits for completion.",
        inputSchema: getAiJobInputSchema,
        outputSchema: durableJobViewSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ id }) => runStructuredTool(async () =>
        parseResearchJobView(await api.getAiJob(id), id)),
    );
  }

  if (researchEnabled) {
    server.registerTool(
      "cancel_ai_job",
      {
        description:
          "Request cancellation for one resource-research job after checking its current canCancel field. The command is explicit, bounded, and safely replayable.",
        inputSchema: cancelAiJobInputSchema,
        outputSchema: durableJobViewSchema,
        annotations: researchCancelMutationAnnotations,
      },
      async ({ id, idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef }) => runStructuredTool(async () =>
        parseResearchJobView(
          await api.cancelAiJob(
            id,
            agentResearchCancelRequestSchema.parse({
              authorizationRef,
              idempotencyKey,
            }),
          ),
          id,
        )),
    );
  }

  if (researchSupported) {
    server.registerTool(
      "list_research_reports",
      {
        description:
          "Read bounded report history for one exact page, resource, or selection fingerprint. Results contain only the agent-safe report summary projection.",
        inputSchema: listResearchReportsInputSchema,
        outputSchema: researchReportListResponseSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ target, limit, before_version: beforeVersion }) =>
        runStructuredTool(async () => researchReportListResponseSchema.parse(
          await api.listResearchReports(
            toResearchReportListQuery(target, limit, beforeVersion),
          ),
        )),
    );

    server.registerTool(
      "get_research_report",
      {
        description:
          "Read one agent-safe research report with claim and safe evidence audit identity, without raw URLs, locators, excerpts, prompts, or local-only context.",
        inputSchema: getResearchReportInputSchema,
        outputSchema: agentResearchReportDetailSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ id }) => runStructuredTool(async () =>
        agentResearchReportDetailSchema.parse(await api.getResearchReport(id))),
    );
  }

  if (userImportanceEnabled) {
    server.registerTool(
      "set_user_importance",
      {
        description:
          "Set or clear personal user importance for one strict page or resource only after an explicit user instruction. The trusted route fixes agent/on_behalf_of_user provenance; this never writes, replaces, or masquerades as an AI priority assessment.",
        inputSchema: setUserImportanceInputSchema,
        outputSchema: agentUserImportanceResponseSchema,
        annotations: mutationAnnotations,
      },
      async ({
        value,
        idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef,
        ...subjectInput
      }) => runStructuredTool(async () => {
        const command = agentUserImportanceRequestSchema.parse({
          subject: toPrioritySubject(subjectInput),
          value,
          idempotencyKey,
          authorizationRef,
        });
        const result: AgentUserImportanceResponse =
          await api.setUserImportance(command);
        return agentUserImportanceResponseSchema.parse(result);
      }),
    );
  }

  server.registerTool(
    "review_disposable_pages",
    {
      description:
        "Review personalized disposable-page suggestions with reasons and safety warnings. This only returns suggestions; it never closes or deletes pages.",
      inputSchema: retentionPageInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ page, page_size: pageSize }) =>
      runTool(() => api.reviewDisposablePages({ page, pageSize })),
  );

  if (resourcesEnabled) {
    server.registerTool(
      "list_resources",
      {
        description:
          "List TabHub resources with bounded pagination and public aggregate counts/activity. Personal user evaluation remains separate from any future AI assessment.",
        inputSchema: listResourcesInputSchema,
        annotations: openWorldReadOnlyAnnotations,
      },
      async (input) =>
        runTool(async () =>
          formatResourceList(await api.listResources(toListResourcesInput(input))),
        ),
    );

    server.registerTool(
      "get_resource",
      {
        description:
          "Get one public TabHub resource, including distinct logical/browser/physical-open counts and honest all-time activity. coverageStart is null until historical coverage is established.",
        inputSchema: resourceInputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ resource_id: resourceId }) =>
        runTool(async () => formatResourceDetail(await api.getResource(resourceId))),
    );

    if (resourceActivityEnabled) {
      server.registerTool(
        "get_resource_activity",
        {
          description:
            "Get the exact persisted 7-day, 30-day, or all-time activity rollup for one TabHub resource, including coverage and UTC window boundaries.",
          inputSchema: resourceActivityInputSchema,
          outputSchema: resourceActivityResponseSchema,
          annotations: readOnlyAnnotations,
        },
        async ({ resource_id: resourceId, window }) =>
          runStructuredTool(() => api.getResourceActivity(resourceId, window)),
      );
    }

    server.registerTool(
      "get_resource_context",
      {
        description:
          "Read only the shareable context projection for one resource. Local-only entries, hidden counts, revisions, IDs, and private-existence signals are never returned.",
        inputSchema: resourceInputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ resource_id: resourceId }) =>
        runTool(async () =>
          formatShareableResourceContext(await api.getResourceContext(resourceId)),
        ),
    );

    server.registerTool(
      "set_resource_context",
      {
        description:
          "Append shareable context to one resource. Omit provenance only for an explicit user instruction, recorded as agent/on_behalf_of_user; autonomous model output must supply strict model provenance. Replays require the same idempotency key and payload.",
        inputSchema: setResourceContextInputSchema,
        annotations: mutationAnnotations,
      },
      async ({
        resource_id: resourceId,
        entry_kind: entryKind,
        body,
        stale_at: staleAt,
        idempotency_key: idempotencyKey,
        provenance,
      }) =>
        runTool(async () =>
          formatContextMutationReceipt(await api.setResourceContext({
            resourceId,
            command: {
              kind: "append",
              entryKind,
              body,
              provenance: toAgentProvenance(provenance),
              ...(staleAt === undefined ? {} : { staleAt }),
              idempotencyKey,
            },
          })),
        ),
    );

    server.registerTool(
      "set_resource_evaluation",
      {
        description:
          "Compatibility alias for setting or clearing a resource's personal user importance only after an explicit user instruction. The trusted server requires authorization and records agent/on_behalf_of_user; this is never an autonomous AI assessment.",
        inputSchema: setResourceEvaluationInputSchema,
        outputSchema: agentUserImportanceResponseSchema,
        annotations: mutationAnnotations,
      },
      async ({
        resource_id: resourceId,
        evaluation,
        idempotency_key: idempotencyKey,
        authorization_ref: authorizationRef,
      }) =>
        runStructuredTool(() =>
          api.setResourceEvaluation({
            resourceId,
            evaluation,
            authorizationRef,
            idempotencyKey,
          }),
        ),
    );

    server.registerResource(
      "resource",
      new ResourceTemplate("tabhub://resource/{id}", { list: undefined }),
      {
        title: "TabHub resource",
        description:
          "A public resource detail plus its shareable context projection. Local-only context and private-existence metadata are omitted.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const rawId = Array.isArray(variables.id)
          ? variables.id[0]
          : variables.id;
        const resourceId = Number(rawId);
        if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
          throw new Error(`Invalid TabHub resource ID: ${String(rawId)}`);
        }
        const [resource, context] = await Promise.all([
          api.getResource(resourceId),
          api.getResourceContext(resourceId),
        ]);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(formatResourceProjection(resource, context)),
            },
          ],
        };
      },
    );
  }

  server.registerTool(
    "set_page_retention",
    {
      description:
        "Record that a page should be kept or reviewed later. This never closes the page or moves it to trash.",
      inputSchema: setPageRetentionInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ id, decision }) =>
      runTool(() => api.setRetentionDecision({ tabId: id, decision })),
  );

  server.registerTool(
    "close_and_forget_page",
    {
      description:
        "After explicit user confirmation, close every known physical instance of a page and move its TabHub record to the seven-day trash. If closure cannot be verified exactly, the page is not trashed.",
      inputSchema: closeAndForgetPageInputSchema,
      annotations: destructiveMutationAnnotations,
    },
    async ({ id, confirmed }) =>
      runTool(() => api.closeAndForgetPage({ tabId: id, confirmed })),
  );

  server.registerTool(
    "list_retention_trash",
    {
      description:
        "List pages in TabHub's reversible retention trash, including their scheduled permanent-deletion time.",
      inputSchema: retentionPageInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ page, page_size: pageSize }) =>
      runTool(() => api.listRetentionTrash({ page, pageSize })),
  );

  server.registerTool(
    "restore_retention_page",
    {
      description:
        "Restore a page from TabHub's retention trash and record it as a page to keep.",
      inputSchema: restoreRetentionPageInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ id }) => runTool(() => api.restoreRetentionPage(id)),
  );

  server.registerTool(
    "list_tabs",
    {
      description:
        "List TabHub tabs with REST-compatible filters, including text search or tabs similar to a positive tab ID, and pagination.",
      inputSchema: listTabsInputSchema,
      annotations: openWorldReadOnlyAnnotations,
    },
    async (input) => runTool(() => api.listTabs(toListTabsInput(input))),
  );

  server.registerTool(
    "get_tab",
    {
      description:
        "Get one TabHub tab. Captured page text is omitted unless include_content is true.",
      inputSchema: getTabInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ id, include_content: includeContent }) =>
      runTool(async () => formatTabForTool(await api.getTab(id), includeContent)),
  );

  server.registerTool(
    "search_tabs",
    {
      description:
        "Search captured TabHub tabs using full-text or semantic search.",
      inputSchema: searchTabsInputSchema,
      annotations: openWorldReadOnlyAnnotations,
    },
    async (input) =>
      runTool(() =>
        api.listTabs({
          ...toListTabsInput({
            ...(input.browser === undefined ? {} : { browser: input.browser }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.importance === undefined
              ? {}
              : { importance: input.importance }),
            ...(input.is_open === undefined ? {} : { is_open: input.is_open }),
            q: input.query,
            page: input.page,
            page_size: input.page_size,
          }),
          ...(input.mode === "semantic" ? { searchMode: input.mode } : {}),
        }),
      ),
  );

  server.registerTool(
    "summarize_tab",
    {
      description:
        "Start a short or deep summary for one tab and briefly wait for its result.",
      inputSchema: summarizeTabInputSchema,
      annotations: summaryMutationAnnotations,
    },
    async ({ id, depth }) =>
      runTool(async () => {
        const enqueued = await api.summarizeTab(id, depth);
        return pollSummaryJob(
          api,
          enqueued.jobId,
          summaryPollIntervalMs,
          summaryPollTimeoutMs,
        );
      }),
  );

  server.registerTool(
    "cluster_inbox",
    {
      description:
        "Group inbox tabs by semantic similarity and return proposed clusters.",
      inputSchema: clusterInboxInputSchema,
      annotations: summaryMutationAnnotations,
    },
    async ({ max_clusters: maxClusters }) =>
      runTool(() => api.clusterInbox(maxClusters)),
  );

  server.registerTool(
    "set_status",
    {
      description: "Set the workflow status for one or more TabHub tabs.",
      inputSchema: setStatusInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, status }) => runTool(() => api.setStatus({ ids, status })),
  );

  server.registerTool(
    "set_importance",
    {
      description:
        "DEPRECATED compatibility alias. Use only for an explicit user command to set or clear personal importance on behalf of the user. With logical importance enabled this records agent/on_behalf_of_user; feature-disabled and schema-17 servers receive the legacy scalar write. It is never an AI priority assessment, autonomous inference, recommendation, or model/rule output.",
      inputSchema: setImportanceInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, level }) =>
      runTool(() => api.setImportance({ ids, importance: level })),
  );

  server.registerTool(
    "tag_tabs",
    {
      description:
        "Assign a hierarchical tag path to one or more TabHub tabs.",
      inputSchema: tagTabsInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, tag_path: tagPath }) =>
      runTool(() => api.tagTabs({ ids, tagPath })),
  );

  server.registerTool(
    "link_tabs",
    {
      description: "Create a typed link between two TabHub tabs.",
      inputSchema: linkTabsInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ from, to, kind, note }) =>
      runTool(() =>
        api.linkTabs({
          from,
          to,
          kind,
          ...(note === undefined ? {} : { note }),
        }),
      ),
  );

  server.registerTool(
    "list_tags",
    {
      description: "List the TabHub tag tree with tab counts.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => api.listTags()),
  );

  server.registerTool(
    "get_stats",
    {
      description: "Get aggregate TabHub counts by status, browser, and tag.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => api.getStats()),
  );

  if (contextEnabled) {
    server.registerTool(
      "get_page_context",
      {
        description:
          "Read the shareable context for one logical page. Private local-only entries and hidden counts are never returned.",
        inputSchema: logicalPageInputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ logical_page_id: logicalPageId }) =>
        runTool(() => api.getPageContext(logicalPageId)),
    );

    server.registerTool(
      "search_page_context",
      {
        description:
          "Search shareable context within one explicitly named logical page. The search never reveals private matches or hidden counts.",
        inputSchema: searchPageContextInputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({ logical_page_id: logicalPageId, query, limit }) =>
        runTool(() => api.searchPageContext({ logicalPageId, query, limit })),
    );

    server.registerTool(
      "set_page_context",
      {
        description:
          "Append shareable context to one logical page. Omit provenance only for an explicit user instruction, which is recorded as agent/on_behalf_of_user; autonomous model output must provide strict model provenance. Replays require the same idempotency key and payload.",
        inputSchema: setPageContextInputSchema,
        annotations: mutationAnnotations,
      },
      async ({
        logical_page_id: logicalPageId,
        entry_kind: entryKind,
        body,
        stale_at: staleAt,
        idempotency_key: idempotencyKey,
        provenance,
      }) =>
        runTool(() =>
          api.setPageContext({
            logicalPageId,
            command: {
              kind: "append",
              entryKind,
              body,
              provenance: toAgentProvenance(provenance),
              ...(staleAt === undefined ? {} : { staleAt }),
              idempotencyKey,
            },
          }),
        ),
    );

    server.registerTool(
      "get_tab_session_intent",
      {
        description:
          "Read the shareable session intent for one exact installation, browser session, and physical tab scope without revealing private intent existence or hidden counts.",
        inputSchema: exactTabScopeInputSchema,
        annotations: readOnlyAnnotations,
      },
      async ({
        installation_id: installationId,
        browser_session_id: browserSessionId,
        browser_tab_id: browserTabId,
      }) =>
        runTool(() =>
          api.getTabSessionIntent({
            installationId,
            browserSessionId,
            browserTabId,
          }),
        ),
    );

    server.registerTool(
      "set_tab_session_intent",
      {
        description:
          "Set a shareable intent for one exact physical tab. Omit provenance only for an explicit user instruction; autonomous model output must provide strict model provenance. The server resolves and verifies the current physical page, and replays require the same idempotency key and payload.",
        inputSchema: setTabSessionIntentInputSchema,
        annotations: mutationAnnotations,
      },
      async ({
        installation_id: installationId,
        browser_session_id: browserSessionId,
        browser_tab_id: browserTabId,
        expected_url: expectedUrl,
        body,
        stale_at: staleAt,
        idempotency_key: idempotencyKey,
        provenance,
      }) =>
        runTool(() =>
          api.setTabSessionIntent({
            kind: "set",
            scope: { installationId, browserSessionId, browserTabId },
            expectedUrl,
            body,
            provenance: toAgentProvenance(
              provenance,
            ) as AgentSessionIntentSetCommand["provenance"],
            ...(staleAt === undefined ? {} : { staleAt }),
            idempotencyKey,
          }),
        ),
    );

    server.registerResource(
      "logical-page-context",
      new ResourceTemplate("tabhub://logical-page/{id}", { list: undefined }),
      {
        title: "TabHub logical page context",
        description:
          "The shareable context projection for a TabHub logical page. Private entries and hidden counts are omitted.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const rawId = Array.isArray(variables.id)
          ? variables.id[0]
          : variables.id;
        const logicalPageId = Number(rawId);
        if (!Number.isSafeInteger(logicalPageId) || logicalPageId <= 0) {
          throw new Error(`Invalid TabHub logical page ID: ${String(rawId)}`);
        }
        const context = await api.getPageContext(logicalPageId);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(context),
            },
          ],
        };
      },
    );
  }

  server.registerResource(
    "tab",
    new ResourceTemplate("tabhub://tab/{id}", { list: undefined }),
    {
      title: "TabHub tab",
      description: "A TabHub tab with metadata and captured page content.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables.id)
        ? variables.id[0]
        : variables.id;
      const id = Number(rawId);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Invalid TabHub tab ID: ${String(rawId)}`);
      }

      const tab = await api.getTab(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: formatTabResource(tab),
          },
        ],
      };
    },
  );

  return server;
}
