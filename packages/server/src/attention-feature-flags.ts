export const personalAttentionFeatureFlagNames = [
  "activityDailyWriter",
  "activityWindows",
  "context",
  "logicalImportance",
  "liveAcquisition",
  "pageSummaryCapture",
  "resources",
  "priorityAssessmentWriter",
  "priorityPersonalization",
  "priorityReaders",
  "priorityShadow",
  "privacyPurge",
  "research",
] as const;

export type PersonalAttentionFeatureFlagName =
  (typeof personalAttentionFeatureFlagNames)[number];

export interface PersonalAttentionFeatureFlags {
  readonly activityDailyWriter?: boolean;
  readonly activityWindows?: boolean;
  readonly context: boolean;
  readonly logicalImportance: boolean;
  readonly liveAcquisition?: boolean;
  readonly pageSummaryCapture?: boolean;
  readonly resources: boolean;
  readonly priorityAssessmentWriter?: boolean;
  readonly priorityPersonalization?: boolean;
  readonly priorityReaders?: boolean;
  readonly priorityShadow: boolean;
  readonly privacyPurge?: boolean;
  readonly research: boolean;
}

const environmentKeys: Readonly<
  Record<PersonalAttentionFeatureFlagName, string>
> = {
  activityDailyWriter: "TABHUB_FEATURE_ACTIVITY_DAILY_WRITER",
  activityWindows: "TABHUB_FEATURE_ACTIVITY_WINDOWS",
  context: "TABHUB_FEATURE_CONTEXT",
  logicalImportance: "TABHUB_FEATURE_LOGICAL_IMPORTANCE",
  liveAcquisition: "TABHUB_FEATURE_LIVE_ACQUISITION",
  pageSummaryCapture: "TABHUB_FEATURE_PAGE_SUMMARY_CAPTURE",
  resources: "TABHUB_FEATURE_RESOURCES",
  priorityAssessmentWriter: "TABHUB_FEATURE_PRIORITY_ASSESSMENT_WRITER",
  priorityPersonalization: "TABHUB_FEATURE_PRIORITY_PERSONALIZATION",
  priorityReaders: "TABHUB_FEATURE_PRIORITY_READERS",
  priorityShadow: "TABHUB_FEATURE_PRIORITY_SHADOW",
  privacyPurge: "TABHUB_FEATURE_PRIVACY_PURGE",
  research: "TABHUB_FEATURE_RESEARCH",
};

export const personalAttentionFeatureFlagsOff: PersonalAttentionFeatureFlags =
  Object.freeze({
    activityDailyWriter: false,
    activityWindows: false,
    context: false,
    logicalImportance: false,
    liveAcquisition: false,
    pageSummaryCapture: false,
    priorityAssessmentWriter: false,
    priorityPersonalization: false,
    priorityReaders: false,
    priorityShadow: false,
    privacyPurge: false,
    research: false,
    resources: false,
  });

function parseFeatureFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      throw new Error(`${name} must be one of: 1, true, 0, false`);
  }
}

/**
 * Personal-attention features are deliberately fail-closed. Application
 * construction defaults to the frozen all-off value; only the executable
 * entrypoint resolves the process environment, so deployments opt in explicitly.
 */
export function resolvePersonalAttentionFeatureFlags(
  environment: NodeJS.ProcessEnv = process.env,
): PersonalAttentionFeatureFlags {
  return Object.freeze({
    activityDailyWriter: parseFeatureFlag(
      environmentKeys.activityDailyWriter,
      environment[environmentKeys.activityDailyWriter],
    ),
    activityWindows: parseFeatureFlag(
      environmentKeys.activityWindows,
      environment[environmentKeys.activityWindows],
    ),
    context: parseFeatureFlag(
      environmentKeys.context,
      environment[environmentKeys.context],
    ),
    logicalImportance: parseFeatureFlag(
      environmentKeys.logicalImportance,
      environment[environmentKeys.logicalImportance],
    ),
    liveAcquisition: parseFeatureFlag(
      environmentKeys.liveAcquisition,
      environment[environmentKeys.liveAcquisition],
    ),
    pageSummaryCapture: parseFeatureFlag(
      environmentKeys.pageSummaryCapture,
      environment[environmentKeys.pageSummaryCapture],
    ),
    resources: parseFeatureFlag(
      environmentKeys.resources,
      environment[environmentKeys.resources],
    ),
    priorityAssessmentWriter: parseFeatureFlag(
      environmentKeys.priorityAssessmentWriter,
      environment[environmentKeys.priorityAssessmentWriter],
    ),
    priorityPersonalization: parseFeatureFlag(
      environmentKeys.priorityPersonalization,
      environment[environmentKeys.priorityPersonalization],
    ),
    priorityReaders: parseFeatureFlag(
      environmentKeys.priorityReaders,
      environment[environmentKeys.priorityReaders],
    ),
    priorityShadow: parseFeatureFlag(
      environmentKeys.priorityShadow,
      environment[environmentKeys.priorityShadow],
    ),
    privacyPurge: parseFeatureFlag(
      environmentKeys.privacyPurge,
      environment[environmentKeys.privacyPurge],
    ),
    research: parseFeatureFlag(
      environmentKeys.research,
      environment[environmentKeys.research],
    ),
  });
}

export interface EffectivePriorityFeatureFlags {
  readonly priorityAssessmentWriter: boolean;
  readonly priorityPersonalization: boolean;
  readonly priorityReaders: boolean;
  readonly priorityShadow: boolean;
}

/** Research writers are available only once the unconditional schema-24
 * foundation exists. Readers/privacy are wired separately and remain usable
 * while this writer flag is off. */
export function resolveEffectiveResearchFeature(
  flags: PersonalAttentionFeatureFlags,
  schemaVersion: number,
): boolean {
  return Number.isSafeInteger(schemaVersion) && schemaVersion >= 24 &&
    flags.research === true;
}

/**
 * Discover the unified agent write only when migration 023 has installed its
 * durable receipt table and at least one supported subject type is enabled.
 * Priority capabilities are deliberately unrelated to this authorization path.
 */
export function resolveAgentUserImportanceFeature(
  flags: PersonalAttentionFeatureFlags,
  schemaVersion: number,
): boolean {
  return Number.isSafeInteger(schemaVersion) && schemaVersion >= 23 &&
    (flags.logicalImportance === true || flags.resources === true);
}

/**
 * Resolve only executable C50 capabilities. The raw environment flags remain
 * independent, while readers require their schema and shadow requires readers.
 */
export function resolveEffectivePriorityFeatureFlags(
  flags: PersonalAttentionFeatureFlags,
  schemaVersion: number,
): EffectivePriorityFeatureFlags {
  const readersSchemaReady = Number.isSafeInteger(schemaVersion) && schemaVersion >= 22;
  const writerSchemaReady = Number.isSafeInteger(schemaVersion) && schemaVersion >= 23;
  const priorityReaders = readersSchemaReady && flags.priorityReaders === true;
  return Object.freeze({
    priorityAssessmentWriter:
      writerSchemaReady && flags.priorityAssessmentWriter === true,
    priorityPersonalization:
      writerSchemaReady && priorityReaders &&
      flags.priorityPersonalization === true,
    priorityReaders,
    priorityShadow: priorityReaders && flags.priorityShadow === true,
  });
}
