import { durableJobIdSchema } from "@tabhub/shared";

export type AiJobScheduleKind =
  | "page_summary"
  | "priority_assessment"
  | "resource_research";

export interface AiJobScheduleCandidate {
  readonly id: string;
  readonly kind: AiJobScheduleKind;
  readonly schedulingPriority: number;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface AiJobScheduleUsage {
  readonly running: number;
  readonly attemptsUtcDay: number;
  readonly costUsdUtcDay: number;
}

export interface AiJobScheduleLimit {
  readonly maxConcurrent: number;
  readonly maxAttemptsPerUtcDay: number;
  readonly maxCostUsdPerUtcDay: number | null;
}

export interface AiJobScheduleInput {
  readonly cursor: number;
  readonly eligibleKinds: readonly AiJobScheduleKind[];
  readonly candidates: readonly AiJobScheduleCandidate[];
  readonly usage: Readonly<Record<AiJobScheduleKind, AiJobScheduleUsage>>;
  readonly limits: Readonly<Record<AiJobScheduleKind, AiJobScheduleLimit>>;
}

export interface AiJobScheduleDecision {
  readonly kind: AiJobScheduleKind;
  readonly candidate: AiJobScheduleCandidate;
  readonly slotCursor: number;
  /** Adopt only after the corresponding physical adapter claim succeeds. */
  readonly nextCursorOnSuccessfulClaim: number;
}

export const AI_JOB_SATURATED_CYCLE: readonly AiJobScheduleKind[] = [
  "page_summary",
  "page_summary",
  "page_summary",
  "page_summary",
  "priority_assessment",
  "priority_assessment",
  "resource_research",
] as const;

const allKinds: readonly AiJobScheduleKind[] = [
  "page_summary",
  "priority_assessment",
  "resource_research",
];

function invalid(message: string): never {
  throw new Error(`Invalid AI job schedule input: ${message}`);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function expectedPrefix(kind: AiJobScheduleKind): string {
  return kind === "page_summary" ? "summary" : kind;
}

function physicalId(id: string): number {
  return Number(id.slice(id.indexOf(":") + 1));
}

function validate(input: AiJobScheduleInput): void {
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 ||
      input.cursor >= AI_JOB_SATURATED_CYCLE.length) invalid("cursor");
  if (!Array.isArray(input.eligibleKinds) || !Array.isArray(input.candidates)) {
    invalid("collections");
  }
  const eligible = new Set<AiJobScheduleKind>();
  for (const kind of input.eligibleKinds) {
    if (!allKinds.includes(kind) || eligible.has(kind)) invalid("eligible kinds");
    eligible.add(kind);
  }
  for (const kind of allKinds) {
    const usage = input.usage?.[kind];
    const limit = input.limits?.[kind];
    if (usage === undefined || !isSafeCount(usage.running) ||
        !isSafeCount(usage.attemptsUtcDay) ||
        typeof usage.costUsdUtcDay !== "number" ||
        !Number.isFinite(usage.costUsdUtcDay) || usage.costUsdUtcDay < 0 ||
        usage.costUsdUtcDay > 1e308) {
      invalid(`${kind} usage`);
    }
    if (limit === undefined || !isSafeCount(limit.maxConcurrent) ||
        !isSafeCount(limit.maxAttemptsPerUtcDay) ||
        (limit.maxCostUsdPerUtcDay !== null &&
          (typeof limit.maxCostUsdPerUtcDay !== "number" ||
            !Number.isFinite(limit.maxCostUsdPerUtcDay) ||
            limit.maxCostUsdPerUtcDay < 0 || limit.maxCostUsdPerUtcDay > 1e308))) {
      invalid(`${kind} limit`);
    }
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    const parsedId = durableJobIdSchema.safeParse(candidate.id);
    if (!allKinds.includes(candidate.kind) || !parsedId.success ||
        !candidate.id.startsWith(`${expectedPrefix(candidate.kind)}:`) ||
        !Number.isSafeInteger(candidate.schedulingPriority) ||
        candidate.schedulingPriority < -100 || candidate.schedulingPriority > 100 ||
        !isCanonicalTimestamp(candidate.availableAt) ||
        !isCanonicalTimestamp(candidate.createdAt) || ids.has(candidate.id)) {
      invalid("candidate");
    }
    ids.add(candidate.id);
  }
}

function isWithinLimits(
  usage: AiJobScheduleUsage,
  limits: AiJobScheduleLimit,
): boolean {
  return usage.running < limits.maxConcurrent &&
    usage.attemptsUtcDay < limits.maxAttemptsPerUtcDay &&
    (limits.maxCostUsdPerUtcDay === null ||
      usage.costUsdUtcDay <= limits.maxCostUsdPerUtcDay);
}

function compareCandidate(
  left: AiJobScheduleCandidate,
  right: AiJobScheduleCandidate,
): number {
  return right.schedulingPriority - left.schedulingPriority ||
    left.availableAt.localeCompare(right.availableAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    physicalId(left.id) - physicalId(right.id);
}

export function chooseNextAiJob(
  input: AiJobScheduleInput,
): AiJobScheduleDecision | null {
  validate(input);
  const eligible = new Set(input.eligibleKinds);
  const best = new Map<AiJobScheduleKind, AiJobScheduleCandidate>();
  for (const kind of allKinds) {
    const first = input.candidates
      .filter((candidate) => candidate.kind === kind)
      .sort(compareCandidate)[0];
    if (first !== undefined) best.set(kind, first);
  }

  for (let offset = 0; offset < AI_JOB_SATURATED_CYCLE.length; offset += 1) {
    const slotCursor = (input.cursor + offset) % AI_JOB_SATURATED_CYCLE.length;
    const kind = AI_JOB_SATURATED_CYCLE[slotCursor]!;
    const candidate = best.get(kind);
    if (!eligible.has(kind) || candidate === undefined ||
        !isWithinLimits(input.usage[kind], input.limits[kind])) continue;
    return {
      kind,
      candidate,
      slotCursor,
      nextCursorOnSuccessfulClaim: (slotCursor + 1) % AI_JOB_SATURATED_CYCLE.length,
    };
  }
  return null;
}
