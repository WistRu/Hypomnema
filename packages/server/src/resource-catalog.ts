import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import ipaddr from "ipaddr.js";
import { parse as parseDomain } from "tldts";

import type {
  ResourceRef,
  ResourceResolution,
  ResourceReviewQueueQuery,
  ResourceReviewQueueResponse,
} from "@tabhub/shared";

export const resourceResolverContractVersion = "resource-resolver-v1";
export const resourceResolverPslVersion = "tldts-7.4.10";

const domainParseOptions = Object.freeze({
  allowIcannDomains: true,
  allowPrivateDomains: true,
  detectIp: true,
  detectSpecialUse: true,
  extractHostname: false,
  mixedInputs: false,
  validateHostname: true,
});

type ResourceResolutionState = ResourceResolution["state"];
type ResourceResolutionReason = ResourceResolution["reason"];
type ResourceResearchExclusionReason =
  ResourceResolution["researchExclusionReason"];
type ResourceResearchUrlExclusionReason = Extract<
  ResourceResearchUrlClassification,
  { kind: "excluded" }
>["reason"];

export interface ResourceBackfillResult {
  processed: number;
  resolved: number;
  unmatched: number;
  ambiguous: number;
  excluded: number;
  unchanged: number;
}

export interface ResourceCatalog {
  /**
   * Resolves one persisted logical page and atomically advances immutable
   * assignment/resolution history plus their current heads.
   */
  resolvePage(logicalPageId: number): ResourceResolution;
  previewResourceUrl(url: string, rulesetVersion: number): ResourceUrlPreview;
  /** Repeatable full-corpus projection. Existing manual/on-behalf heads win. */
  backfill(): ResourceBackfillResult;
  getResolution(logicalPageId: number): ResourceResolution | undefined;
  getResource(resourceId: number): ResourceRef | undefined;
  list(input: ResourceReviewQueueQuery): ResourceReviewQueueResponse;
}

export type ResourceUrlPreview = {
  readonly rulesetVersion: number;
  readonly rulesetResourceGenerationFingerprint: string;
} & (
  | {
      readonly kind: "accepted";
      readonly resource: ResourceRef;
      readonly matchedRuleKeys: readonly string[];
    }
  | {
      readonly kind: "ambiguous";
      readonly candidateResourceIds: readonly number[];
      readonly matchedRuleKeys: readonly string[];
    }
  | { readonly kind: "unmatched" }
  | {
      readonly kind: "unsupported";
      readonly reason:
        | ResourceResearchUrlExclusionReason
        | "invalid_ruleset_version"
        | "ruleset_version_mismatch"
        | "resource_generation_missing";
    }
);

interface LogicalPageRow {
  id: number;
  url_normalized: string;
}

interface ResourceRow {
  id: number;
  resource_key: string;
  name: string;
  kind: ResourceRef["kind"];
  access_class: ResourceRef["accessClass"];
  lifecycle_state: ResourceRef["lifecycleState"];
  merged_into_resource_id: number | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: number;
  logical_page_id: number;
  action: "assigned" | "removed";
  resource_id: number | null;
  provenance_class:
    | "user_manual"
    | "agent_on_behalf"
    | "explicit_alias"
    | "system_seed"
    | "registrable_domain";
  rule_id: number | null;
  source_fingerprint: string;
}

interface RuleRow {
  id: number;
  rule_key: string;
  version: number;
  resource_id: number;
  host_pattern: string;
  match_kind: "exact_host" | "suffix_host";
  path_prefix: string;
  priority: number;
  provenance_class: "user_alias" | "agent_alias" | "system_seed";
}

interface ResolutionRow {
  id: number;
  logical_page_id: number;
  state: "matched" | "overridden" | "unmatched" | "ambiguous" | "excluded";
  reason: ResourceResolutionReason;
  resource_id: number | null;
  assignment_id: number | null;
  candidate_resource_ids_json: string;
  source_fingerprint: string;
  research_eligible: 0 | 1;
  research_exclusion_reason: ResourceResearchExclusionReason;
  created_at: string;
}

interface ResolvePlan {
  state: ResourceResolutionState;
  reason: ResourceResolutionReason;
  resourceId: number | null;
  candidateResourceIds: number[];
  assignment: {
    provenanceClass: AssignmentRow["provenance_class"];
    assignedBy: "system" | "user" | "agent";
    assignmentMethod: "manual" | "on_behalf_of_user" | "rule" | "derived";
    ruleId: number | null;
  } | null;
  sourceFingerprint: string;
  researchEligible: boolean;
  researchExclusionReason: ResourceResearchExclusionReason;
}

interface ClassifiedUrl {
  url: URL;
  hostname: string;
  registrableDomain: string | null;
  syntheticReservedDomain: boolean;
  weakSensitiveSignal: boolean;
}

interface PlannedResolution {
  plan: ResolvePlan;
  changed: boolean;
}

function mapResource(row: ResourceRow): ResourceRef {
  return {
    id: row.id,
    resourceKey: row.resource_key,
    name: row.name,
    kind: row.kind,
    accessClass: row.access_class,
    lifecycleState: row.lifecycle_state,
    mergedIntoResourceId: row.merged_into_resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFingerprint(payload: unknown): string {
  return [
    resourceResolverContractVersion,
    `psl=${resourceResolverPslVersion}`,
    "allowPrivateDomains=true",
    `sha256=${sha256(JSON.stringify(payload))}`,
  ].join(";");
}

function canonicalCandidateIds(candidateIds: number[]): number[] {
  return [...new Set(candidateIds)].sort((left, right) => left - right);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isPrivateIp(hostname: string): boolean | undefined {
  if (!ipaddr.isValid(hostname)) return undefined;
  let address = ipaddr.parse(hostname);
  if (address.kind() === "ipv6") {
    const ipv6Address = address as ipaddr.IPv6;
    if (ipv6Address.isIPv4MappedAddress()) {
      address = ipv6Address.toIPv4Address();
    }
  }
  return address.range() !== "unicast";
}

function weakSensitiveSignal(url: URL): boolean {
  const weakSignal =
    /(^|[./_-])(account|accounts|admin|auth|login|signin|sign-in|oauth|sso)([./_-]|$)/i;
  return weakSignal.test(`${url.hostname}${url.pathname}`);
}

function classifyUrl(
  urlText: string,
):
  | { kind: "eligible"; value: ClassifiedUrl }
  | {
      kind: "terminal";
      state: "unmatched" | "excluded";
      reason:
        | "invalid_url"
        | "browser_internal"
        | "extension"
        | "file"
        | "data"
        | "unsupported_scheme"
        | "embedded_credentials"
        | "localhost"
        | "private_ip"
        | "private_hostname"
        | "registrable_domain_unavailable";
    } {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return { kind: "terminal", state: "unmatched", reason: "invalid_url" };
  }

  const protocol = url.protocol.toLowerCase();
  if (["chrome:", "edge:", "about:", "brave:", "opera:"].includes(protocol)) {
    return {
      kind: "terminal",
      state: "excluded",
      reason: "browser_internal",
    };
  }
  if (["chrome-extension:", "moz-extension:"].includes(protocol)) {
    return { kind: "terminal", state: "excluded", reason: "extension" };
  }
  if (protocol === "file:") {
    return { kind: "terminal", state: "excluded", reason: "file" };
  }
  if (protocol === "data:") {
    return { kind: "terminal", state: "excluded", reason: "data" };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      kind: "terminal",
      state: "excluded",
      reason: "unsupported_scheme",
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      kind: "terminal",
      state: "excluded",
      reason: "embedded_credentials",
    };
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { kind: "terminal", state: "excluded", reason: "localhost" };
  }

  const privateIp = isPrivateIp(hostname);
  if (privateIp !== undefined) {
    if (privateIp) {
      return { kind: "terminal", state: "excluded", reason: "private_ip" };
    }
    return {
      kind: "eligible",
      value: {
        url,
        hostname,
        registrableDomain: null,
        syntheticReservedDomain: false,
        weakSensitiveSignal: weakSensitiveSignal(url),
      },
    };
  }

  const parsed = parseDomain(hostname, domainParseOptions);
  // RFC/IANA example names are used by immutable fixtures. They are resolved
  // deterministically for local measurement, but never researchable.
  const reservedExampleDomain = ["example.com", "example.net", "example.org"].find(
    (candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`),
  );
  const syntheticDomain = hostname.endsWith(".example")
    ? hostname.split(".").slice(-2).join(".")
    : (reservedExampleDomain ?? null);
  const syntheticReservedDomain = syntheticDomain !== null;
  if (parsed.isSpecialUse && !syntheticReservedDomain) {
    return {
      kind: "terminal",
      state: "excluded",
      reason: "private_hostname",
    };
  }
  const registrableDomain =
    parsed.isIcann || parsed.isPrivate ? parsed.domain : syntheticDomain;
  if (registrableDomain === null) {
    return {
      kind: "terminal",
      state: "unmatched",
      reason: "registrable_domain_unavailable",
    };
  }
  return {
    kind: "eligible",
    value: {
      url,
      hostname,
      registrableDomain,
      syntheticReservedDomain,
      weakSensitiveSignal: weakSensitiveSignal(url),
    },
  };
}

export type ResourceResearchUrlClassification =
  | { readonly kind: "eligible" }
  | {
      readonly kind: "excluded";
      readonly category: "format" | "privacy";
      readonly reason:
        | "invalid_url"
        | "browser_internal"
        | "extension"
        | "file"
        | "data"
        | "unsupported_scheme"
        | "embedded_credentials"
        | "localhost"
        | "private_ip"
        | "private_hostname"
        | "registrable_domain_unavailable"
        | "weak_sensitive_signal";
    };

/**
 * Canonical Resource URL gate reused by captured-only research. Access class is
 * intentionally handled by the research approval confirmation, not here.
 */
export function classifyResourceUrlForResearch(
  urlText: string,
): ResourceResearchUrlClassification {
  const classified = classifyUrl(urlText);
  if (classified.kind === "eligible") {
    if (classified.value.syntheticReservedDomain) {
      return { kind: "excluded", category: "privacy", reason: "private_hostname" };
    }
    if (classified.value.weakSensitiveSignal) {
      return { kind: "excluded", category: "privacy", reason: "weak_sensitive_signal" };
    }
    return { kind: "eligible" };
  }
  const category = [
    "invalid_url",
    "browser_internal",
    "extension",
    "file",
    "data",
    "unsupported_scheme",
  ].includes(classified.reason) ? "format" as const : "privacy" as const;
  return { kind: "excluded", category, reason: classified.reason };
}

function rulePrecedence(rule: RuleRow): number {
  return rule.provenance_class === "system_seed" ? 1 : 2;
}

interface RuleMatch {
  rule: RuleRow;
  exactHost: boolean;
  semanticScore: readonly [number, number, number, number, number];
}

function matchRules(classified: ClassifiedUrl, rules: RuleRow[]): RuleMatch[] {
  return rules.flatMap((rule): RuleMatch[] => {
    const exactHost = classified.hostname === rule.host_pattern;
    const hostMatches =
      exactHost ||
      (rule.match_kind === "suffix_host" &&
        classified.hostname.endsWith(`.${rule.host_pattern}`));
    const pathMatches =
      rule.path_prefix === "/" ||
      classified.url.pathname === rule.path_prefix ||
      classified.url.pathname.startsWith(
        rule.path_prefix.endsWith("/")
          ? rule.path_prefix
          : `${rule.path_prefix}/`,
      );
    if (!hostMatches || !pathMatches) {
      return [];
    }
    return [
      {
        rule,
        exactHost,
        semanticScore: [
          rulePrecedence(rule),
          rule.priority,
          exactHost ? 1 : 0,
          rule.path_prefix.length,
          rule.host_pattern.length,
        ],
      },
    ];
  });
}

function compareScore(
  left: RuleMatch["semanticScore"],
  right: RuleMatch["semanticScore"],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameResolution(left: ResolutionRow | undefined, right: ResolvePlan): boolean {
  if (left === undefined) return false;
  const publicState =
    left.state === "matched" || left.state === "overridden"
      ? "resolved"
      : left.state;
  const expectedPersistedState =
    right.state === "resolved"
      ? right.reason === "user_manual" || right.reason === "agent_on_behalf"
        ? "overridden"
        : "matched"
      : right.state;
  return (
    publicState === right.state &&
    left.state === expectedPersistedState &&
    left.reason === right.reason &&
    left.resource_id === right.resourceId &&
    JSON.stringify(canonicalCandidateIds(JSON.parse(left.candidate_resource_ids_json) as number[])) ===
      JSON.stringify(right.candidateResourceIds) &&
    left.source_fingerprint === right.sourceFingerprint &&
    left.research_eligible === (right.researchEligible ? 1 : 0)
    && left.research_exclusion_reason === right.researchExclusionReason
  );
}

export function createResourceCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
): ResourceCatalog {
  const selectPage = connection.prepare(`
    SELECT id, url_normalized
    FROM logical_pages
    WHERE id = ?
  `);
  const selectAllPageIds = connection.prepare(`
    SELECT id
    FROM logical_pages
    ORDER BY id
  `);
  const selectResource = connection.prepare(`
    SELECT
      resources.id,
      resources.resource_key,
      resource_events.name,
      resource_events.kind,
      resource_events.access_class,
      resource_events.lifecycle_state,
      resource_events.merged_into_resource_id,
      resources.created_at,
      resource_events.created_at AS updated_at
    FROM resources
    JOIN resource_heads ON resource_heads.resource_id = resources.id
    JOIN resource_events ON resource_events.id = resource_heads.event_id
    WHERE resources.id = ?
  `);
  const selectResourceByKey = connection.prepare(`
    SELECT
      resources.id,
      resources.resource_key,
      resource_events.name,
      resource_events.kind,
      resource_events.access_class,
      resource_events.lifecycle_state,
      resource_events.merged_into_resource_id,
      resources.created_at,
      resource_events.created_at AS updated_at
    FROM resources
    JOIN resource_heads ON resource_heads.resource_id = resources.id
    JOIN resource_events ON resource_events.id = resource_heads.event_id
    WHERE resources.resource_key = ?
  `);
  const selectCurrentAssignment = connection.prepare(`
    SELECT assignments.*
    FROM logical_page_resource_heads AS heads
    JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = heads.assignment_id
    WHERE heads.logical_page_id = ?
  `);
  const selectCurrentRules = connection.prepare(`
    SELECT rules.*
    FROM resource_match_rule_heads AS heads
    JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
    JOIN resource_heads ON resource_heads.resource_id = rules.resource_id
    JOIN resource_events ON resource_events.id = resource_heads.event_id
    WHERE rules.enabled = 1 AND resource_events.lifecycle_state = 'active'
  `);
  const selectCurrentRulesetVersion = connection.prepare(`
    SELECT events.version
    FROM resource_ruleset_heads AS heads
    JOIN resource_ruleset_events AS events ON events.id = heads.ruleset_event_id
    WHERE heads.scope = 'global'
  `);
  const hasPrivacySubjectGenerations = connection.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'privacy_subject_generations'
  `).get() !== undefined;
  const selectActiveResourceGeneration = hasPrivacySubjectGenerations
    ? connection.prepare(`
        SELECT id, generation_token
        FROM privacy_subject_generations
        WHERE subject_kind = 'resource' AND resource_id = ? AND is_active = 1
      `)
    : undefined;
  const selectCurrentResolution = connection.prepare(`
    SELECT events.*
    FROM resource_resolution_heads AS heads
    JOIN resource_resolution_events AS events
      ON events.id = heads.resolution_event_id
    WHERE heads.logical_page_id = ?
  `);
  const insertResource = connection.prepare(`
    INSERT INTO resources (resource_key, created_at)
    VALUES (?, ?)
    ON CONFLICT (resource_key) DO NOTHING
  `);
  const insertResourceEvent = connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'website', 'public', 'active', 'system', 'derived', ?)
  `);
  const insertResourceHead = connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `);
  const ensureResourcePreference = connection.prepare(`
    INSERT INTO resource_preferences (resource_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT (resource_id) DO NOTHING
  `);
  const insertAssignment = connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, rule_id, source_fingerprint, supersedes_id, created_at
    ) VALUES (
      @logicalPageId, @action, @resourceId, @provenanceClass, @assignedBy,
      @assignmentMethod, @ruleId, @sourceFingerprint, @supersedesId, @createdAt
    )
  `);
  const upsertAssignmentHead = connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (?, ?)
    ON CONFLICT (logical_page_id) DO UPDATE SET assignment_id = excluded.assignment_id
  `);
  const insertResolution = connection.prepare(`
    INSERT INTO resource_resolution_events (
      logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      research_exclusion_reason, supersedes_id, created_at
    ) VALUES (
      @logicalPageId, @state, @reason, @resourceId, @assignmentId,
      @candidateResourceIdsJson, @sourceFingerprint, @researchEligible,
      @researchExclusionReason, @supersedesId, @createdAt
    )
  `);
  const upsertResolutionHead = connection.prepare(`
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (?, ?)
    ON CONFLICT (logical_page_id) DO UPDATE SET
      resolution_event_id = excluded.resolution_event_id
  `);
  const countReviewQueue = connection.prepare(`
    SELECT COUNT(*)
    FROM resource_resolution_heads AS heads
    JOIN resource_resolution_events AS events
      ON events.id = heads.resolution_event_id
    WHERE events.state IN ('unmatched', 'ambiguous')
  `);
  const selectReviewQueue = connection.prepare(`
    SELECT events.*, logical_pages.url_normalized,
      assignment_heads.assignment_id AS current_assignment_id
    FROM resource_resolution_heads AS heads
    JOIN resource_resolution_events AS events
      ON events.id = heads.resolution_event_id
    JOIN logical_pages ON logical_pages.id = heads.logical_page_id
    LEFT JOIN logical_page_resource_heads AS assignment_heads
      ON assignment_heads.logical_page_id = events.logical_page_id
    WHERE events.state IN ('unmatched', 'ambiguous')
    ORDER BY events.created_at ASC, events.logical_page_id ASC
    LIMIT ? OFFSET ?
  `);

  const getResource = (resourceId: number): ResourceRef | undefined => {
    const row = selectResource.get(resourceId) as ResourceRow | undefined;
    return row === undefined ? undefined : mapResource(row);
  };

  const getOrCreateDerivedResource = (
    resourceKey: string,
    name: string,
    now: string,
  ): ResourceRow => {
    let row = selectResourceByKey.get(resourceKey) as ResourceRow | undefined;
    if (row !== undefined) return row;
    const inserted = insertResource.run(resourceKey, now);
    if (inserted.changes === 1) {
      const resourceId = Number(inserted.lastInsertRowid);
      const event = insertResourceEvent.run(resourceId, name, now);
      insertResourceHead.run(resourceId, Number(event.lastInsertRowid));
      ensureResourcePreference.run(resourceId, now);
    }
    row = selectResourceByKey.get(resourceKey) as ResourceRow | undefined;
    if (row === undefined) {
      throw new Error(`Failed to create derived resource ${resourceKey}`);
    }
    return row;
  };

  const terminalPlan = (
    page: LogicalPageRow,
    state: "unmatched" | "excluded",
    reason: ResolvePlan["reason"],
  ): ResolvePlan => ({
    state,
    reason,
    resourceId: null,
    candidateResourceIds: [],
    assignment: null,
    sourceFingerprint: sourceFingerprint({
      logicalPageId: page.id,
      urlNormalized: page.url_normalized,
      state,
      reason,
    }),
    researchEligible: false,
    researchExclusionReason: reason as ResourceResearchExclusionReason,
  });

  const researchPolicy = (
    resource: ResourceRow,
    classified:
      | { kind: "eligible"; value: ClassifiedUrl }
      | {
          kind: "terminal";
          state: "unmatched" | "excluded";
          reason: ResourceResearchExclusionReason;
        },
  ): {
    researchEligible: boolean;
    researchExclusionReason: ResourceResearchExclusionReason;
  } => {
    if (classified.kind === "terminal") {
      return {
        researchEligible: false,
        researchExclusionReason: classified.reason,
      };
    }
    if (resource.access_class === "authenticated") {
      return {
        researchEligible: false,
        researchExclusionReason: "authenticated_access",
      };
    }
    if (resource.access_class === "sensitive") {
      return {
        researchEligible: false,
        researchExclusionReason: "sensitive_access",
      };
    }
    if (classified.value.syntheticReservedDomain) {
      return {
        researchEligible: false,
        researchExclusionReason: "private_hostname",
      };
    }
    if (classified.value.weakSensitiveSignal) {
      return {
        researchEligible: false,
        researchExclusionReason: "weak_sensitive_signal",
      };
    }
    return { researchEligible: true, researchExclusionReason: null };
  };

  const buildPlan = (page: LogicalPageRow, now: string): ResolvePlan => {
    const classified = classifyUrl(page.url_normalized);
    const currentAssignment = selectCurrentAssignment.get(page.id) as
      | AssignmentRow
      | undefined;
    if (
      currentAssignment?.action === "assigned" &&
      currentAssignment.resource_id !== null &&
      (currentAssignment.provenance_class === "user_manual" ||
        currentAssignment.provenance_class === "agent_on_behalf")
    ) {
      const resource = selectResource.get(currentAssignment.resource_id) as
        | ResourceRow
        | undefined;
      if (resource === undefined) {
        throw new Error(`Assignment ${currentAssignment.id} has no current resource`);
      }
      const reason = currentAssignment.provenance_class;
      const policy = researchPolicy(resource, classified);
      return {
        state: "resolved",
        reason,
        resourceId: resource.id,
        candidateResourceIds: [resource.id],
        assignment: {
          provenanceClass: currentAssignment.provenance_class,
          assignedBy:
            currentAssignment.provenance_class === "user_manual" ? "user" : "agent",
          assignmentMethod:
            currentAssignment.provenance_class === "user_manual"
              ? "manual"
              : "on_behalf_of_user",
          ruleId: null,
        },
        sourceFingerprint: sourceFingerprint({
          logicalPageId: page.id,
          urlNormalized: page.url_normalized,
          assignmentId: currentAssignment.id,
          assignmentFingerprint: currentAssignment.source_fingerprint,
          reason,
        }),
        ...policy,
      };
    }

    if (classified.kind === "terminal") {
      return terminalPlan(page, classified.state, classified.reason);
    }

    const matches = matchRules(
      classified.value,
      selectCurrentRules.all() as RuleRow[],
    ).sort((left, right) => compareScore(left.semanticScore, right.semanticScore));
    if (matches.length > 0) {
      const topScore = matches[0]?.semanticScore;
      const tied = matches.filter(
        (match) => topScore !== undefined && compareScore(match.semanticScore, topScore) === 0,
      );
      const candidateResourceIds = canonicalCandidateIds(
        tied.map(({ rule }) => rule.resource_id),
      );
      const matchedRuleKeys = tied
        .map(({ rule }) => `${rule.rule_key}@${rule.version}`)
        .sort();
      if (candidateResourceIds.length > 1) {
        return {
          state: "ambiguous",
          reason: "authoritative_tie",
          resourceId: null,
          candidateResourceIds,
          assignment: null,
          sourceFingerprint: sourceFingerprint({
            logicalPageId: page.id,
            urlNormalized: page.url_normalized,
            matchedRuleKeys,
            state: "ambiguous",
          }),
          researchEligible: false,
          researchExclusionReason: "authoritative_tie",
        };
      }
      const selected = tied
        .filter(({ rule }) => rule.resource_id === candidateResourceIds[0])
        .sort((left, right) =>
          `${left.rule.rule_key}@${left.rule.version}`.localeCompare(
            `${right.rule.rule_key}@${right.rule.version}`,
          ),
        )[0];
      if (selected === undefined) {
        throw new Error("A rule match did not produce a resource candidate");
      }
      const resource = selectResource.get(selected.rule.resource_id) as
        | ResourceRow
        | undefined;
      if (resource === undefined) {
        throw new Error(`Rule ${selected.rule.id} has no current resource`);
      }
      const reason =
        selected.rule.provenance_class === "system_seed"
          ? "system_seed"
          : "explicit_alias";
      const policy = researchPolicy(resource, classified);
      return {
        state: "resolved",
        reason,
        resourceId: resource.id,
        candidateResourceIds: [resource.id],
        assignment: {
          provenanceClass: reason,
          assignedBy: "system",
          assignmentMethod: "rule",
          ruleId: selected.rule.id,
        },
        sourceFingerprint: sourceFingerprint({
          logicalPageId: page.id,
          urlNormalized: page.url_normalized,
          selectedRule: `${selected.rule.rule_key}@${selected.rule.version}`,
          matchedRuleKeys,
          reason,
        }),
        ...policy,
      };
    }

    if (classified.value.weakSensitiveSignal) {
      return terminalPlan(page, "unmatched", "weak_sensitive_signal");
    }
    if (classified.value.registrableDomain === null) {
      return terminalPlan(page, "unmatched", "registrable_domain_unavailable");
    }
    const keyPrefix = isPrivateIp(classified.value.registrableDomain) === false
      ? "host"
      : "domain";
    const resource = getOrCreateDerivedResource(
      `${keyPrefix}:${classified.value.registrableDomain}`,
      classified.value.registrableDomain,
      now,
    );
    return {
      state: "resolved",
      reason: "registrable_domain",
      resourceId: resource.id,
      candidateResourceIds: [resource.id],
      assignment: {
        provenanceClass: "registrable_domain",
        assignedBy: "system",
        assignmentMethod: "derived",
        ruleId: null,
      },
      sourceFingerprint: sourceFingerprint({
        logicalPageId: page.id,
        urlNormalized: page.url_normalized,
        registrableDomain: classified.value.registrableDomain,
        syntheticReservedDomain: classified.value.syntheticReservedDomain,
        reason: "registrable_domain",
      }),
      researchEligible: !classified.value.syntheticReservedDomain,
      researchExclusionReason: classified.value.syntheticReservedDomain
        ? "private_hostname"
        : null,
    };
  };

  const persistPlan = (
    page: LogicalPageRow,
    plan: ResolvePlan,
    now: string,
  ): PlannedResolution => {
    const currentResolution = selectCurrentResolution.get(page.id) as
      | ResolutionRow
      | undefined;
    if (sameResolution(currentResolution, plan)) {
      return { plan, changed: false };
    }

    const currentAssignment = selectCurrentAssignment.get(page.id) as
      | AssignmentRow
      | undefined;
    let assignmentId: number | null = null;
    if (plan.state === "resolved" && plan.resourceId !== null && plan.assignment !== null) {
      const assignmentUnchanged =
        currentAssignment?.action === "assigned" &&
        currentAssignment.resource_id === plan.resourceId &&
        currentAssignment.provenance_class === plan.assignment.provenanceClass &&
        currentAssignment.rule_id === plan.assignment.ruleId &&
        currentAssignment.source_fingerprint === plan.sourceFingerprint;
      if (assignmentUnchanged) {
        assignmentId = currentAssignment.id;
      } else if (
        currentAssignment?.action === "assigned" &&
        (currentAssignment.provenance_class === "user_manual" ||
          currentAssignment.provenance_class === "agent_on_behalf")
      ) {
        assignmentId = currentAssignment.id;
      } else {
        const inserted = insertAssignment.run({
          logicalPageId: page.id,
          action: "assigned",
          resourceId: plan.resourceId,
          provenanceClass: plan.assignment.provenanceClass,
          assignedBy: plan.assignment.assignedBy,
          assignmentMethod: plan.assignment.assignmentMethod,
          ruleId: plan.assignment.ruleId,
          sourceFingerprint: plan.sourceFingerprint,
          supersedesId: currentAssignment?.id ?? null,
          createdAt: now,
        });
        assignmentId = Number(inserted.lastInsertRowid);
        upsertAssignmentHead.run(page.id, assignmentId);
      }
    } else if (
      currentAssignment !== undefined &&
      currentAssignment.action === "assigned" &&
      currentAssignment.provenance_class !== "user_manual" &&
      currentAssignment.provenance_class !== "agent_on_behalf"
    ) {
      const inserted = insertAssignment.run({
        logicalPageId: page.id,
        action: "removed",
        resourceId: null,
        provenanceClass: "registrable_domain",
        assignedBy: "system",
        assignmentMethod: "derived",
        ruleId: null,
        sourceFingerprint: plan.sourceFingerprint,
        supersedesId: currentAssignment.id,
        createdAt: now,
      });
      upsertAssignmentHead.run(page.id, Number(inserted.lastInsertRowid));
    }

    const insertedResolution = insertResolution.run({
      logicalPageId: page.id,
      state:
        plan.state === "resolved"
          ? plan.reason === "user_manual" || plan.reason === "agent_on_behalf"
            ? "overridden"
            : "matched"
          : plan.state,
      reason: plan.reason,
      resourceId: plan.resourceId,
      assignmentId,
      candidateResourceIdsJson: JSON.stringify(plan.candidateResourceIds),
      sourceFingerprint: plan.sourceFingerprint,
      researchEligible: plan.researchEligible ? 1 : 0,
      researchExclusionReason: plan.researchExclusionReason,
      supersedesId: currentResolution?.id ?? null,
      createdAt: now,
    });
    upsertResolutionHead.run(page.id, Number(insertedResolution.lastInsertRowid));
    return { plan, changed: true };
  };

  const resolutionFromRow = (row: ResolutionRow): ResourceResolution => {
    const common = {
      logicalPageId: row.logical_page_id,
      candidateResourceIds: canonicalCandidateIds(
        JSON.parse(row.candidate_resource_ids_json) as number[],
      ),
      sourceFingerprint: row.source_fingerprint,
      resolvedAt: row.created_at,
    };
    if (row.state === "matched" || row.state === "overridden") {
      if (row.resource_id === null) {
        throw new Error(`Resolved event ${row.id} has no resource`);
      }
      const resource = getResource(row.resource_id);
      if (resource === undefined) {
        throw new Error(`Resolved event ${row.id} references a missing resource`);
      }
      return {
        ...common,
        state: "resolved",
        reason: row.reason as Extract<
          ResourceResolution,
          { state: "resolved" }
        >["reason"],
        resource,
        researchEligible: row.research_eligible === 1,
        researchExclusionReason: row.research_exclusion_reason as Extract<
          ResourceResolution,
          { state: "resolved" }
        >["researchExclusionReason"],
      };
    }
    if (row.state === "ambiguous") {
      return {
        ...common,
        state: "ambiguous",
        reason: "authoritative_tie",
        resource: null,
        researchEligible: false,
        researchExclusionReason: "authoritative_tie",
      };
    }
    if (row.state === "excluded") {
      return {
        ...common,
        state: "excluded",
        reason: row.reason as Extract<
          ResourceResolution,
          { state: "excluded" }
        >["reason"],
        resource: null,
        researchEligible: false,
        researchExclusionReason: row.research_exclusion_reason as Extract<
          ResourceResolution,
          { state: "excluded" }
        >["researchExclusionReason"],
      };
    }
    return {
      ...common,
      state: "unmatched",
      reason: row.reason as Extract<
        ResourceResolution,
        { state: "unmatched" }
      >["reason"],
      resource: null,
      researchEligible: false,
      researchExclusionReason: row.research_exclusion_reason as Extract<
        ResourceResolution,
        { state: "unmatched" }
      >["researchExclusionReason"],
    };
  };

  const resolveInternal = (logicalPageId: number): PlannedResolution => {
    const page = selectPage.get(logicalPageId) as LogicalPageRow | undefined;
    if (page === undefined) {
      throw new Error(`Logical page ${logicalPageId} does not exist`);
    }
    const now = clock().toISOString();
    const plan = buildPlan(page, now);
    return persistPlan(page, plan, now);
  };
  const resolveTransaction = connection.transaction(resolveInternal);
  const backfillTransaction = connection.transaction((): ResourceBackfillResult => {
    const result: ResourceBackfillResult = {
      processed: 0,
      resolved: 0,
      unmatched: 0,
      ambiguous: 0,
      excluded: 0,
      unchanged: 0,
    };
    for (const { id } of selectAllPageIds.all() as Array<{ id: number }>) {
      const resolved = resolveInternal(id);
      result.processed += 1;
      result[resolved.plan.state] += 1;
      if (!resolved.changed) result.unchanged += 1;
    }
    return result;
  });

  const previewResourceUrl = (urlText: string, requestedRulesetVersion: number):
    ResourceUrlPreview => {
    const rulesetVersion = Number(selectCurrentRulesetVersion.pluck().get());
    const generationIdentity = (resourceIds: readonly number[]) => {
      const resources = resourceIds.map((resourceId) => {
        const generation = selectActiveResourceGeneration?.get(resourceId) as
          | { id: number; generation_token: string }
          | undefined;
        return generation === undefined
          ? { resourceId, generationId: null, generationToken: null }
          : {
              resourceId,
              generationId: generation.id,
              generationToken: generation.generation_token,
            };
      });
      return sha256(JSON.stringify({
        contract: "resource_url_preview_generation:v1",
        rulesetVersion,
        resources,
      }));
    };
    const unsupported = (
      reason: Extract<ResourceUrlPreview, { kind: "unsupported" }>["reason"],
    ): ResourceUrlPreview => ({
      kind: "unsupported",
      reason,
      rulesetVersion,
      rulesetResourceGenerationFingerprint: generationIdentity([]),
    });
    if (!Number.isSafeInteger(requestedRulesetVersion) || requestedRulesetVersion <= 0) {
      return unsupported("invalid_ruleset_version");
    }
    if (requestedRulesetVersion !== rulesetVersion) {
      return unsupported("ruleset_version_mismatch");
    }
    const classified = classifyUrl(urlText);
    if (classified.kind === "terminal") return unsupported(classified.reason);
    const matches = matchRules(
      classified.value,
      selectCurrentRules.all() as RuleRow[],
    ).sort((left, right) => compareScore(left.semanticScore, right.semanticScore));
    if (matches.length === 0) {
      return {
        kind: "unmatched",
        rulesetVersion,
        rulesetResourceGenerationFingerprint: generationIdentity([]),
      };
    }
    const topScore = matches[0]!.semanticScore;
    const tied = matches.filter((match) => compareScore(match.semanticScore, topScore) === 0);
    const candidateResourceIds = canonicalCandidateIds(tied.map((match) => match.rule.resource_id));
    const matchedRuleKeys = tied.map((match) => `${match.rule.rule_key}@${match.rule.version}`)
      .sort();
    const fingerprint = generationIdentity(candidateResourceIds);
    if (candidateResourceIds.length > 1) {
      return {
        kind: "ambiguous",
        rulesetVersion,
        candidateResourceIds,
        matchedRuleKeys,
        rulesetResourceGenerationFingerprint: fingerprint,
      };
    }
    const resourceId = candidateResourceIds[0]!;
    const resource = getResource(resourceId);
    if (resource === undefined || resource.lifecycleState !== "active") {
      return unsupported("resource_generation_missing");
    }
    if (selectActiveResourceGeneration !== undefined &&
        selectActiveResourceGeneration.get(resourceId) === undefined) {
      return unsupported("resource_generation_missing");
    }
    return {
      kind: "accepted",
      rulesetVersion,
      resource,
      matchedRuleKeys,
      rulesetResourceGenerationFingerprint: fingerprint,
    };
  };

  return {
    resolvePage(logicalPageId) {
      if (connection.inTransaction) {
        resolveInternal(logicalPageId);
      } else {
        resolveTransaction(logicalPageId);
      }
      const row = selectCurrentResolution.get(logicalPageId) as ResolutionRow;
      if (row === undefined) {
        throw new Error(`Resolution for logical page ${logicalPageId} was not persisted`);
      }
      return resolutionFromRow(row);
    },

    previewResourceUrl,

    backfill() {
      return backfillTransaction();
    },

    getResolution(logicalPageId) {
      const row = selectCurrentResolution.get(logicalPageId) as
        | ResolutionRow
        | undefined;
      return row === undefined ? undefined : resolutionFromRow(row);
    },

    getResource,

    list(input) {
      const total = Number(countReviewQueue.pluck().get());
      const rows = selectReviewQueue.all(
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as Array<
        ResolutionRow & {
          current_assignment_id: number | null;
          url_normalized: string;
        }
      >;
      return {
        items: rows.map((row) => ({
          logicalPageId: row.logical_page_id,
          urlNormalized: row.url_normalized,
          state: row.state as "unmatched" | "ambiguous",
          reason: row.reason as ResourceReviewQueueResponse["items"][number]["reason"],
          candidateResourceIds: canonicalCandidateIds(
            JSON.parse(row.candidate_resource_ids_json) as number[],
          ),
          currentAssignmentId: row.current_assignment_id,
          sourceFingerprint: row.source_fingerprint,
          resolvedAt: row.created_at,
        })),
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    },
  };
}
