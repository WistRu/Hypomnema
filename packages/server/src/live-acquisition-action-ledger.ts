import { createHash, createHmac } from "node:crypto";

import { researchCanonicalSha256PayloadV1 } from "@tabhub/shared";
import type Database from "better-sqlite3";

import {
  classifyLiveAcquisitionUrl,
  classifyPublicDnsAnswers,
  isRobotsPathAllowed,
  parseRobotsPolicy,
  parseRetryAfter,
  type DnsAddressAnswer,
} from "./live-acquisition-policy.js";
import { createLogicalPageCatalog } from "./logical-page-catalog.js";
import { normalizeUrl } from "./normalize-url.js";
import { createResourceCatalog, type ResourceUrlPreview } from "./resource-catalog.js";

interface PrivacyPurgeExternalAbortLease {
  readonly expected: Set<string>;
}

const privacyPurgeExternalAbortLeases = new WeakMap<Database.Database,
  PrivacyPurgeExternalAbortLease | null>();

function privacyPurgeExternalAbortKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

/** Installs only the inert fence consumer; it cannot arm mutation authority. */
export function installLiveAcquisitionPrivacyPurgeAbortFence(
  connection: Database.Database,
): void {
  privacyPurgeExternalAbortLeases.set(connection, null);
  connection.function("tabhub_purge26_external_abort_v1", {
    deterministic: false, varargs: true,
  }, (...parts: unknown[]) => {
    const lease = privacyPurgeExternalAbortLeases.get(connection);
    if (lease === null || lease === undefined || !connection.inTransaction) return 0;
    return lease.expected.delete(privacyPurgeExternalAbortKey(parts)) ? 1 : 0;
  });
}

function runWithPrivacyPurgeExternalAbortFence(
  connection: Database.Database,
  identity: {
    readonly requestDigest: string;
    readonly actionId: number;
    readonly executionKeyDigest: string;
  },
  mutations: readonly {
    readonly tableName: "live_acquisition_actions" | "live_acquisition_action_events";
    readonly operation: "UPDATE" | "INSERT";
    readonly oldPk: string;
    readonly newPk: string;
    readonly newRowDigest: string;
  }[],
  body: () => void,
): void {
  if (!connection.inTransaction ||
      privacyPurgeExternalAbortLeases.get(connection) !== null ||
      mutations.length !== 2) {
    throw new Error("invalid privacy purge external abort capability");
  }
  const valid = connection.prepare(`
    SELECT 1
    FROM privacy_purge_action_abort_requests AS request
    JOIN privacy_purge_intents AS intent ON intent.intent_key = request.intent_key
    JOIN privacy_purge_intent_action_waits AS wait
      ON wait.intent_key = request.intent_key AND wait.ordinal = request.ordinal
    JOIN live_acquisition_actions AS action ON action.id = request.action_id
    WHERE request.request_digest = ? AND request.request_kind = 'current_exact'
      AND request.action_id = ? AND request.execution_key_digest = ?
      AND intent.status = 'waiting' AND wait.terminal_state IS NULL
      AND action.state = 'started'
  `).get(identity.requestDigest, identity.actionId, identity.executionKeyDigest);
  if (valid === undefined) throw new Error("invalid privacy purge external abort identity");
  const expected = new Set(mutations.map((mutation) => privacyPurgeExternalAbortKey([
    identity.requestDigest, identity.actionId, identity.executionKeyDigest,
    mutation.tableName, mutation.operation, mutation.oldPk, mutation.newPk,
    mutation.newRowDigest,
  ])));
  if (expected.size !== 2) throw new Error("invalid privacy purge external abort mutations");
  const lease = { expected };
  privacyPurgeExternalAbortLeases.set(connection, lease);
  try {
    body();
    if (!connection.inTransaction || lease.expected.size !== 0) {
      throw new Error("privacy purge external abort transaction escaped");
    }
  } finally {
    if (privacyPurgeExternalAbortLeases.get(connection) === lease) {
      privacyPurgeExternalAbortLeases.set(connection, null);
    }
  }
}

export type ActionState = "planned" | "resolution_started" | "resolved" | "authorized" |
  "started" | "completed" | "blocked" | "ambiguous";
export type ActionOutcomeCode = "DNS_RESULT_UNKNOWN" | "RUNTIME_RESTARTED_BEFORE_REQUEST" |
  "IPV4_REQUIRED_V1" | "PARTIAL_RESPONSE" | "META_REFRESH" | "AUTH_REQUIRED" |
  "CHALLENGE_PAGE" | "SPA_SHELL" | "INSUFFICIENT_PUBLIC_TEXT" | "INVALID_UTF8" |
  "CONSENT_EXPIRED_IN_FLIGHT" | "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH" |
  "SENSITIVE_URL_CAPTURE_REQUIRED" | "LIVE_ACQUISITION_DISABLED" |
  "LIVE_ACQUISITION_DISABLED_IN_FLIGHT" | "POLICY_BLOCKED" |
  "TRANSPORT_DNS_FAILURE" | "TRANSPORT_CONNECT_FAILURE" | "TRANSPORT_TLS_FAILURE" |
  "TRANSPORT_TIMEOUT" | "HTTP_INFORMATIONAL" | "HTTP_SUCCESS" | "HTTP_REDIRECT" |
  "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "RESPONSE_SIZE_LIMIT" |
  "FETCH_COMPLETED" | "CANCELLED" | "BUDGET_EXHAUSTED";

interface ActionRow {
  id: number;
  consent_id: number;
  coordinator_run_generation_id: number;
  resource_generation_id: number;
  logical_page_generation_id: number | null;
  history_epoch_id: number;
  runtime_epoch: number;
  action_kind: "page" | "robots";
  depth: number | null;
  discovered_from_action_id: number | null;
  state: ActionState;
  sequence_no: number;
  exact_url: string;
  expires_at: string;
}

export interface PlannedLiveAcquisitionAction {
  readonly id: number;
  readonly state: ActionState;
  readonly canonicalUrl: string;
  readonly canonicalOrigin: string;
}

export interface LiveAcquisitionResolution {
  readonly normalizedAnswers: readonly string[];
  readonly selectedIpv4: string;
  readonly answerSetDigest: string;
  readonly selectedIpv4Digest: string;
}

export interface LiveAcquisitionActionLedger {
  planPage(input: { readonly consentId: number; readonly logicalPageId: number; readonly url: string }):
    PlannedLiveAcquisitionAction;
  planUnknownPage(input: { readonly consentId: number; readonly url: string }):
    PlannedLiveAcquisitionAction;
  planRobots(input: { readonly consentId: number; readonly canonicalOrigin: string }):
    PlannedLiveAcquisitionAction;
  beginResolution(actionId: number): void;
  recordResolution(actionId: number, resolution: LiveAcquisitionResolution): void;
  authorize(actionId: number): { readonly authorizationDigest: string; readonly expiresAt: string };
  start(actionId: number): void;
  reserveRequest(actionId: number): void;
  block(
    actionId: number,
    code: ActionOutcomeCode,
    ambiguous?: boolean,
    retryAfter?: string,
    visitedPage?: boolean,
  ): void;
  blockForPrivacyPurgeAbort(actionId: number, provenance: {
    readonly requestDigest: string;
    readonly executionKeyDigest: string;
  }): void;
  completePage(actionId: number, result: {
    readonly rawBody: Uint8Array;
    readonly extractedText: string;
    readonly contentDigest: string;
    readonly responseMetadataDigest: string;
    readonly discoveredLinks?: readonly string[];
  }): { readonly admittedActionIds: readonly number[] };
  completeRobots(actionId: number, result: {
    readonly policyDigest: string;
    readonly crawlDelayMs: number;
    readonly policyText: string;
  }): void;
  advanceRuntimeEpochAndRecover(writerEnabled: boolean): {
    readonly runtimeEpoch: number;
    readonly recoveredActions: number;
    readonly recoveredJobs: number;
    readonly releasedReservations: number;
  };
  read(actionId: number): ActionRow;
}

export interface LiveAcquisitionOwnedMutation {
  readonly tableName: "live_acquisition_action_events" |
    "live_acquisition_actions" | "live_acquisition_checkpoints";
  readonly operation: "INSERT" | "UPDATE";
  readonly oldPkV1: string;
  readonly newPkV1: string;
  readonly newRow?: Readonly<Record<string, unknown>>;
}

interface LedgerOptions {
  readonly clock?: () => Date;
  readonly previewResourceUrl?: (url: string, rulesetVersion: number) => ResourceUrlPreview;
  readonly transactionBound?: boolean;
  readonly authorizeOwnedMutation?: (mutation: LiveAcquisitionOwnedMutation) => void;
  readonly testOnlyMaterializationCheckpoint?: (
    phase: "logical_page" | "resource_resolution",
  ) => void;
}

export class LiveAcquisitionActionPolicyError extends Error {
  constructor(readonly code: ActionOutcomeCode) {
    super(code);
    this.name = "LiveAcquisitionActionPolicyError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

function canonicalTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("invalid clock");
  return value.toISOString();
}

function immediate<T>(
  connection: Database.Database,
  body: () => T,
  transactionBound = false,
): T {
  if (connection.inTransaction) {
    if (!transactionBound) throw new Error("live acquisition action requires autocommit");
    return body();
  }
  if (transactionBound) throw new Error("transaction-bound live acquisition action requires a transaction");
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

export function createLiveAcquisitionActionLedger(
  connection: Database.Database,
  options: LedgerOptions = {},
): LiveAcquisitionActionLedger {
  const clock = options.clock ?? (() => new Date());
  const transact = <T>(body: () => T): T =>
    immediate(connection, body, options.transactionBound === true);
  const previewResourceUrl = options.previewResourceUrl ??
    createResourceCatalog(connection).previewResourceUrl;
  const selectRuleset = connection.prepare(`
    SELECT event.id, event.version
    FROM resource_ruleset_heads AS head
    JOIN resource_ruleset_events AS event ON event.id = head.ruleset_event_id
    WHERE head.scope = 'global'
  `);
  const selectRules = connection.prepare(`
    SELECT rule.rule_key, rule.version, rule.host_pattern, rule.path_prefix,
      rule.priority, rule.enabled, rule.resource_id
    FROM resource_match_rule_heads AS head
    JOIN resource_match_rules AS rule ON rule.id = head.rule_id
    ORDER BY rule.rule_key
  `);
  const selectAction = connection.prepare(`
    SELECT action.*, url.exact_url, consent.expires_at,
      CASE WHEN action.action_kind = 'page' THEN (
        SELECT generation.id
        FROM logical_pages AS page
        JOIN privacy_subject_generations AS generation
          ON generation.subject_kind = 'logical_page'
          AND generation.logical_page_id = page.id
          AND generation.is_active = 1
        WHERE page.url_normalized = tabhub_normalize_url_v2(url.exact_url)
        ORDER BY generation.id DESC LIMIT 1
      ) END AS logical_page_generation_id
    FROM live_acquisition_actions AS action
    JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
    JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
    WHERE action.id = ?
  `);
  const insertEvent = connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (@actionId, @sequenceNo, @fromState, @toState, @outcomeCode,
      @safeDetailsJson, @at)
  `);
  const insertEventWithId = connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      id, action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (@id, @actionId, @sequenceNo, @fromState, @toState, @outcomeCode,
      @safeDetailsJson, @at)
  `);

  function integerPk(value: number): string {
    const text = String(value);
    return `pk:v1|1|i:${text.length}:${text}`;
  }

  function read(actionId: number): ActionRow {
    const row = selectAction.get(actionId) as ActionRow | undefined;
    if (row === undefined) throw new Error("live acquisition action not found");
    return row;
  }

  function transition(
    row: ActionRow,
    toState: ActionState,
    outcomeCode: ActionOutcomeCode | null,
    safeDetails: Readonly<Record<string, string | number>> = {},
    at = canonicalTimestamp(clock),
  ): void {
    const values = {
      actionId: row.id,
      sequenceNo: row.sequence_no + 1,
      fromState: row.state,
      toState,
      outcomeCode,
      safeDetailsJson: JSON.stringify(safeDetails),
      at,
    };
    if (options.authorizeOwnedMutation === undefined) {
      insertEvent.run(values);
      return;
    }
    const id = Number(connection.prepare(`
      SELECT COALESCE(MAX(id), 0) + 1 FROM live_acquisition_action_events
    `).pluck().get());
    options.authorizeOwnedMutation({
      tableName: "live_acquisition_actions",
      operation: "UPDATE",
      oldPkV1: integerPk(row.id),
      newPkV1: integerPk(row.id),
    });
    options.authorizeOwnedMutation({
      tableName: "live_acquisition_action_events",
      operation: "INSERT",
      oldPkV1: "",
      newPkV1: integerPk(id),
      newRow: {
        id,
        action_id: values.actionId,
        sequence_no: values.sequenceNo,
        from_state: values.fromState,
        to_state: values.toState,
        outcome_code: values.outcomeCode,
        safe_details_json: values.safeDetailsJson,
        occurred_at: values.at,
      },
    });
    insertEventWithId.run({ id, ...values });
  }

  function validateExactPageMembership(input: {
    readonly actionKind: "page" | "robots";
    readonly exactUrl: string;
    readonly resourceGenerationId: number;
    readonly frozenRulesetDigest: string;
    readonly frozenResourceGenerationDigest: string;
  }): void {
    if (input.actionKind === "robots") return;
    const ruleset = selectRuleset.get() as { id: number; version: number } | undefined;
    if (ruleset === undefined) {
      throw new LiveAcquisitionActionPolicyError(
        "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
      );
    }
    const currentRulesetDigest = sha256(canonicalJson({
      eventId: ruleset.id,
      version: ruleset.version,
      rules: selectRules.all(),
    }));
    const target = connection.prepare(`
      SELECT resource_id, is_active, generation_token
      FROM privacy_subject_generations
      WHERE id = ? AND subject_kind = 'resource'
    `).get(input.resourceGenerationId) as {
      resource_id: number;
      is_active: number;
      generation_token: string;
    } | undefined;
    const preview = previewResourceUrl(input.exactUrl, ruleset.version);
    const previewGenerationId = preview.kind === "accepted"
      ? connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'resource' AND resource_id = ? AND is_active = 1
        `).pluck().get(preview.resource.id) as number | undefined
      : undefined;
    if (currentRulesetDigest !== input.frozenRulesetDigest || target === undefined ||
        target.is_active !== 1 ||
        target.generation_token !== input.frozenResourceGenerationDigest ||
        preview.kind !== "accepted" ||
        preview.resource.id !== target.resource_id ||
        previewGenerationId !== input.resourceGenerationId) {
      throw new LiveAcquisitionActionPolicyError(
        "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
      );
    }
  }

  function validateCurrentPolicy(row: ActionRow, at: string): ReturnType<typeof classifyLiveAcquisitionUrl> {
    const policy = classifyLiveAcquisitionUrl(row.exact_url);
    if (policy.kind === "blocked") throw new Error(policy.code);
    const owner = connection.prepare(`
      SELECT consent.status, consent.expires_at, consent.runtime_epoch,
        runtime.runtime_epoch AS current_epoch, payload.approved_origins_json,
        json_extract(consent.limits_json, '$.ruleset_generation_digest')
          AS frozen_ruleset_digest,
        json_extract(consent.limits_json, '$.resource_generation_digest')
          AS frozen_resource_generation_digest,
        resource_generation.is_active AS resource_active,
        run_generation.is_active AS run_active,
        history.is_active AS history_active,
        COALESCE(page_generation.is_active, 1) AS page_active
      FROM live_acquisition_consents AS consent
      JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
      JOIN live_acquisition_consent_payloads AS payload ON payload.consent_id = consent.id
      JOIN privacy_subject_generations AS resource_generation
        ON resource_generation.id = consent.resource_generation_id
      JOIN privacy_subject_generations AS run_generation
        ON run_generation.id = consent.coordinator_run_generation_id
      JOIN research_history_epochs AS history ON history.id = consent.history_epoch_id
      LEFT JOIN privacy_subject_generations AS page_generation
        ON page_generation.id = ?
      WHERE consent.id = ?
    `).get(row.logical_page_generation_id, row.consent_id) as {
      status: string; expires_at: string; runtime_epoch: number; current_epoch: number;
      approved_origins_json: string; resource_active: number; run_active: number;
      history_active: number; page_active: number; frozen_ruleset_digest: string;
      frozen_resource_generation_digest: string;
    } | undefined;
    if (owner === undefined || owner.status !== "active" || owner.expires_at <= at ||
        owner.runtime_epoch !== owner.current_epoch || row.runtime_epoch !== owner.current_epoch ||
        owner.resource_active !== 1 || owner.run_active !== 1 || owner.history_active !== 1 ||
        owner.page_active !== 1 ||
        !(JSON.parse(owner.approved_origins_json) as unknown[]).includes(policy.canonicalOrigin)) {
      throw new Error("live acquisition action fence changed");
    }
    validateExactPageMembership({
      actionKind: row.action_kind,
      exactUrl: row.exact_url,
      resourceGenerationId: row.resource_generation_id,
      frozenRulesetDigest: owner.frozen_ruleset_digest,
      frozenResourceGenerationDigest: owner.frozen_resource_generation_digest,
    });
    return policy;
  }

  function validateAuthorizationExpiry(row: ActionRow, at: string): void {
    const expiresAt = connection.prepare(`
      SELECT expires_at FROM live_acquisition_action_authorizations
      WHERE action_id = ? AND runtime_epoch = ?
    `).pluck().get(row.id, row.runtime_epoch) as string | undefined;
    if (expiresAt === undefined || expiresAt <= at) {
      throw new Error("live acquisition authorization expired");
    }
  }

  function nextUpdateTimestamp(at: string, previous: string): string {
    return at > previous ? at : new Date(Date.parse(previous) + 1).toISOString();
  }

  function inspectCourtesy(row: ActionRow, at: string): {
    readonly runId: number;
    readonly originDigest: string;
    readonly courtesy: {
      readonly robots_policy_digest: string | null;
      readonly next_allowed_at: string | null;
      readonly retry_after_until: string | null;
      readonly updated_at: string;
    } | undefined;
  } {
    const originDigest = sha256(new URL(row.exact_url).origin);
    const runId = connection.prepare(`
      SELECT research_run_id FROM privacy_subject_generations WHERE id = ?
    `).pluck().get(row.coordinator_run_generation_id) as number | null;
    if (runId === null) throw new Error("live acquisition run generation is detached");
    if (Number(connection.prepare(`
      SELECT COUNT(*) FROM live_acquisition_actions
      WHERE state = 'started' AND id <> ?
    `).pluck().get(row.id)) !== 0) {
      throw new Error("live acquisition request concurrency is occupied");
    }
    const courtesy = connection.prepare(`
      SELECT robots_policy_digest, next_allowed_at, retry_after_until, updated_at
      FROM live_acquisition_origin_courtesy_state
      WHERE coordinator_run_id = ? AND canonical_origin_digest = ?
    `).get(runId, originDigest) as {
      robots_policy_digest: string | null;
      next_allowed_at: string | null;
      retry_after_until: string | null;
      updated_at: string;
    } | undefined;
    if (row.action_kind === "page" && (courtesy?.robots_policy_digest === null ||
        courtesy === undefined || (courtesy.next_allowed_at !== null && courtesy.next_allowed_at > at) ||
        (courtesy.retry_after_until !== null && courtesy.retry_after_until > at))) {
      throw new Error("origin courtesy does not authorize page start");
    }
    return { runId, originDigest, courtesy };
  }

  function commitCourtesyStart(
    row: ActionRow,
    at: string,
    inspected: ReturnType<typeof inspectCourtesy>,
  ): void {
    const courtesyAt = inspected.courtesy === undefined
      ? at : nextUpdateTimestamp(at, inspected.courtesy.updated_at);
    const nextAllowedAt = new Date(Date.parse(courtesyAt) + 2_000).toISOString();
    if (inspected.courtesy === undefined) {
      connection.prepare(`
        INSERT INTO live_acquisition_origin_courtesy_state (
          coordinator_run_id, coordinator_run_generation_id, consent_id,
          canonical_origin_digest, origin_digest, robots_policy_digest,
          last_request_at, next_allowed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(inspected.runId, row.coordinator_run_generation_id, row.consent_id,
        inspected.originDigest, inspected.originDigest, courtesyAt, nextAllowedAt, courtesyAt);
      return;
    }
    connection.prepare(`
      UPDATE live_acquisition_origin_courtesy_state
      SET last_request_at = ?, next_allowed_at = ?, updated_at = ?
      WHERE coordinator_run_id = ? AND canonical_origin_digest = ?
    `).run(courtesyAt, nextAllowedAt, courtesyAt, inspected.runId, inspected.originDigest);
  }

  function syncCheckpoint(row: ActionRow, at: string, allowRetiredEpoch = false): void {
    const owner = connection.prepare(`
      SELECT consent.coordinator_job_id, consent.runtime_epoch, attempt.id AS attempt_id,
        runtime.runtime_epoch AS current_runtime_epoch
      FROM live_acquisition_consents AS consent
      JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
      JOIN ai_job_attempts AS attempt
        ON attempt.job_id = consent.coordinator_job_id AND attempt.outcome = 'running'
      WHERE consent.id = ?
      ORDER BY attempt.attempt_no DESC, attempt.id DESC LIMIT 1
    `).get(row.consent_id) as {
      coordinator_job_id: number;
      runtime_epoch: number;
      attempt_id: number;
      current_runtime_epoch: number;
    } | undefined;
    if (owner === undefined) return;
    const previousUpdatedAt = connection.prepare(`
      SELECT updated_at FROM live_acquisition_checkpoints WHERE attempt_id = ?
    `).pluck().get(owner.attempt_id) as string | undefined;
    if (owner.runtime_epoch !== owner.current_runtime_epoch &&
        (!allowRetiredEpoch || previousUpdatedAt === undefined)) return;
    const counters = connection.prepare(`
      SELECT
        SUM(CASE WHEN action.action_kind = 'page' AND EXISTS (
          SELECT 1 FROM live_acquisition_page_reservations AS reservation
          WHERE reservation.action_id = action.id
            AND reservation.consent_id = action.consent_id
        ) THEN 1 ELSE 0 END) AS reserved_pages,
        SUM(CASE WHEN action.action_kind = 'page' AND (
          action.state = 'completed' OR EXISTS (
            SELECT 1 FROM live_acquisition_action_events AS terminal_event
            WHERE terminal_event.action_id = action.id
              AND terminal_event.to_state IN ('blocked', 'ambiguous')
              AND json_extract(terminal_event.safe_details_json, '$.response_class') = 'success'
          )
        ) THEN 1 ELSE 0 END) AS visited_pages,
        SUM(CASE WHEN action.action_kind = 'page' AND action.state = 'completed'
          THEN 1 ELSE 0 END) AS captured_pages,
        SUM(CASE WHEN action.action_kind = 'page' AND action.state = 'blocked'
          THEN 1 ELSE 0 END) AS blocked_pages,
        SUM(CASE WHEN action.action_kind = 'page' AND action.state = 'ambiguous'
          THEN 1 ELSE 0 END) AS ambiguous_pages,
        SUM(CASE WHEN action.action_kind = 'robots' AND EXISTS (
          SELECT 1 FROM live_acquisition_action_events AS event
          WHERE event.action_id = action.id AND event.to_state = 'started'
        ) THEN 1 ELSE 0 END) AS robots_actions,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM live_acquisition_action_events AS event
          WHERE event.action_id = action.id AND event.to_state = 'started'
        ) THEN 1 ELSE 0 END) AS network_actions,
        SUM(CASE WHEN action.state = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous_actions
      FROM live_acquisition_actions AS action
      WHERE action.consent_id = ?
    `).get(row.consent_id) as {
      reserved_pages: number;
      visited_pages: number;
      captured_pages: number;
      blocked_pages: number;
      ambiguous_pages: number;
      robots_actions: number;
      network_actions: number;
      ambiguous_actions: number;
    };
    const queueRows = connection.prepare(`
      SELECT id, state FROM live_acquisition_actions
      WHERE consent_id = ? AND state NOT IN ('completed', 'blocked', 'ambiguous')
      ORDER BY id
    `).all(row.consent_id) as Array<{ id: number; state: ActionState }>;
    const stage = queueRows.length > 0 ? "acquiring"
      : counters.ambiguous_actions > 0 ? "ambiguous"
        : counters.captured_pages > 0 ? "ready_for_handoff" : "no_eligible_source";
    const checkpointJson = JSON.stringify({
      version: 1,
      stage,
      consentId: row.consent_id,
      runtimeEpoch: owner.runtime_epoch,
      counters: {
        reservedPages: counters.reserved_pages,
        visitedPages: counters.visited_pages,
        capturedPages: counters.captured_pages,
        blockedPages: counters.blocked_pages,
        ambiguousPages: counters.ambiguous_pages,
        robotsActions: counters.robots_actions,
        networkActions: counters.network_actions,
      },
      queue: {
        plannedActionIds: queueRows.filter(({ state }) => state === "planned").map(({ id }) => id),
        activeActionIds: queueRows.filter(({ state }) => state !== "planned").map(({ id }) => id),
      },
    });
    const updatedAt = previousUpdatedAt === undefined ? at
      : nextUpdateTimestamp(at, previousUpdatedAt);
    if (previousUpdatedAt === undefined) {
      options.authorizeOwnedMutation?.({
        tableName: "live_acquisition_checkpoints",
        operation: "INSERT",
        oldPkV1: "",
        newPkV1: integerPk(owner.attempt_id),
        newRow: {
          attempt_id: owner.attempt_id,
          coordinator_job_id: owner.coordinator_job_id,
          consent_id: row.consent_id,
          runtime_epoch: owner.runtime_epoch,
          checkpoint_json: checkpointJson,
          checkpoint_digest: sha256(checkpointJson),
          updated_at: updatedAt,
        },
      });
      connection.prepare(`
        INSERT INTO live_acquisition_checkpoints (
          attempt_id, coordinator_job_id, consent_id, runtime_epoch,
          checkpoint_json, checkpoint_digest, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(owner.attempt_id, owner.coordinator_job_id, row.consent_id,
        owner.runtime_epoch, checkpointJson, sha256(checkpointJson), updatedAt);
    } else {
      options.authorizeOwnedMutation?.({
        tableName: "live_acquisition_checkpoints",
        operation: "UPDATE",
        oldPkV1: integerPk(owner.attempt_id),
        newPkV1: integerPk(owner.attempt_id),
      });
      connection.prepare(`
        UPDATE live_acquisition_checkpoints
        SET checkpoint_json = ?, checkpoint_digest = ?, updated_at = ?
        WHERE attempt_id = ?
      `).run(checkpointJson, sha256(checkpointJson), updatedAt, owner.attempt_id);
    }
  }

  function plan(
    consentId: number,
    actionKind: "page" | "robots",
    logicalPageId: number | null,
    rawUrl: string,
    allowUnknownPage = false,
    traversal?: { readonly depth: number; readonly discoveredFromActionId: number },
    alreadyInTransaction = false,
  ): PlannedLiveAcquisitionAction {
    const policy = classifyLiveAcquisitionUrl(rawUrl);
    if (policy.kind === "blocked") throw new Error(policy.code);
    const at = canonicalTimestamp(clock);
    const execute = (): PlannedLiveAcquisitionAction => {
      const owner = connection.prepare(`
        SELECT consent.resource_generation_id, consent.history_epoch_id,
          consent.coordinator_run_generation_id, consent.runtime_epoch,
          consent.status, consent.expires_at, payload.approved_origins_json,
          json_extract(consent.limits_json, '$.max_pages') AS max_pages,
          json_extract(consent.limits_json, '$.ruleset_generation_digest')
            AS frozen_ruleset_digest,
          json_extract(consent.limits_json, '$.resource_generation_digest')
            AS frozen_resource_generation_digest,
          digest_key.digest_key,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'logical_page' AND logical_page_id = @logicalPageId
             AND is_active = 1) AS logical_page_generation_id
        FROM live_acquisition_consents AS consent
        JOIN live_acquisition_consent_payloads AS payload ON payload.consent_id = consent.id
        JOIN live_acquisition_digest_keys AS digest_key ON digest_key.consent_id = consent.id
        JOIN live_acquisition_runtime_state AS runtime
          ON runtime.singleton_id = 1 AND runtime.runtime_epoch = consent.runtime_epoch
        WHERE consent.id = @consentId
      `).get({ consentId, logicalPageId }) as {
        resource_generation_id: number; history_epoch_id: number;
        coordinator_run_generation_id: number; runtime_epoch: number; status: string;
        expires_at: string; approved_origins_json: string; digest_key: Buffer;
        max_pages: number;
        frozen_ruleset_digest: string;
        frozen_resource_generation_digest: string;
        logical_page_generation_id: number | null;
      } | undefined;
      if (owner === undefined || owner.status !== "active" || owner.expires_at <= at ||
          !(JSON.parse(owner.approved_origins_json) as unknown[]).includes(policy.canonicalOrigin) ||
          (actionKind === "page" && owner.logical_page_generation_id === null &&
            !allowUnknownPage)) {
        throw new Error("live acquisition consent does not authorize URL");
      }
      validateExactPageMembership({
        actionKind,
        exactUrl: policy.canonicalFetchUrl,
        resourceGenerationId: owner.resource_generation_id,
        frozenRulesetDigest: owner.frozen_ruleset_digest,
        frozenResourceGenerationDigest: owner.frozen_resource_generation_digest,
      });
      const originDigest = sha256(policy.canonicalOrigin);
      const existing = connection.prepare(`
        SELECT action.id FROM live_acquisition_actions AS action
        WHERE action.coordinator_run_generation_id = ? AND action.action_kind = ?
          AND ((? = 'page' AND action.canonical_fetch_url_fingerprint = ?)
            OR (? = 'robots' AND action.canonical_origin_digest = ?))
      `).pluck().get(
        owner.coordinator_run_generation_id,
        actionKind,
        actionKind,
        policy.urlFingerprint,
        actionKind,
        originDigest,
      ) as number | undefined;
      if (existing !== undefined) {
        const row = read(existing);
        const stored = connection.prepare(`
          SELECT exact_url, keyed_url_digest
          FROM live_acquisition_url_payloads WHERE action_id = ?
        `).get(existing) as {
          exact_url: string;
          keyed_url_digest: string;
        } | undefined;
        const expectedDigest = createHmac("sha256", owner.digest_key)
          .update(policy.canonicalFetchUrl).digest("hex");
        if (stored === undefined || stored.exact_url !== policy.canonicalFetchUrl ||
            stored.keyed_url_digest !== expectedDigest || row.exact_url !== stored.exact_url) {
          throw new Error("live acquisition action replay identity mismatch");
        }
        return { id: row.id, state: row.state, canonicalUrl: policy.canonicalFetchUrl,
          canonicalOrigin: policy.canonicalOrigin };
      }
      if (actionKind === "page") {
        const plannedPages = Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_actions
          WHERE consent_id = ? AND action_kind = 'page' AND state = 'planned'
        `).pluck().get(consentId));
        if (plannedPages >= 1000) {
          throw new Error("live acquisition planned page queue limit exceeded");
        }
      }
      const actionKeyDigest = sha256(JSON.stringify({
        runGenerationId: owner.coordinator_run_generation_id,
        actionKind,
        identity: actionKind === "page" ? policy.urlFingerprint : originDigest,
      }));
      const result = connection.prepare(`
        INSERT INTO live_acquisition_actions (
          consent_id, coordinator_run_generation_id, resource_generation_id,
          history_epoch_id, runtime_epoch, action_kind, depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest, action_key_digest,
          state, sequence_no, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?)
      `).run(
        consentId,
        owner.coordinator_run_generation_id,
        owner.resource_generation_id,
        owner.history_epoch_id,
        owner.runtime_epoch,
        actionKind,
        actionKind === "page" ? traversal?.depth ?? 0 : null,
        actionKind === "page" ? traversal?.discoveredFromActionId ?? null : null,
        actionKind === "page" ? policy.urlFingerprint : null,
        actionKind === "robots" ? originDigest : null,
        actionKeyDigest,
        at,
      );
      const id = Number(result.lastInsertRowid);
      connection.prepare(`
        INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
        VALUES (?, ?, ?)
      `).run(id, policy.canonicalFetchUrl,
        createHmac("sha256", owner.digest_key).update(policy.canonicalFetchUrl).digest("hex"));
      transition(read(id), "planned", null, {}, at);
      return { id, state: "planned", canonicalUrl: policy.canonicalFetchUrl,
        canonicalOrigin: policy.canonicalOrigin };
    };
    return alreadyInTransaction ? execute() : transact(execute);
  }

  const ledger: LiveAcquisitionActionLedger = {
    planPage: ({ consentId, logicalPageId, url }) => plan(consentId, "page", logicalPageId, url),
    planUnknownPage: ({ consentId, url }) => plan(consentId, "page", null, url, true),
    planRobots: ({ consentId, canonicalOrigin }) => {
      const parsed = new URL(canonicalOrigin);
      if (parsed.origin !== canonicalOrigin) throw new Error("robots origin must be canonical");
      return plan(consentId, "robots", null, `${canonicalOrigin}/robots.txt`);
    },
    beginResolution(actionId) {
      let rejection: unknown;
      immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "planned" || row.sequence_no !== 1) {
          throw new Error("only a never-started planned action may resolve");
        }
        const at = canonicalTimestamp(clock);
        if (row.expires_at <= at) {
          transition(row, "blocked", "CANCELLED", { outcome_class: "cancelled" }, at);
          syncCheckpoint(read(actionId), at);
          rejection = new Error("live acquisition action fence changed: consent expired before request");
          return;
        }
        if (row.action_kind === "page") {
          const reservationSequence = Number(connection.prepare(`
            SELECT COUNT(*) + 1 FROM live_acquisition_page_reservations
            WHERE consent_id = ?
          `).pluck().get(row.consent_id));
          try {
            connection.prepare(`
              INSERT INTO live_acquisition_page_reservations (
                consent_id, action_id, reservation_sequence, reserved_at
              ) VALUES (?, ?, ?, ?)
            `).run(row.consent_id, row.id, reservationSequence, at);
          } catch (error) {
            if (!(error instanceof Error) ||
                !/page reservation budget exhausted/u.test(error.message)) throw error;
            transition(row, "blocked", "BUDGET_EXHAUSTED", {
              outcome_class: "blocked",
            }, at);
            const suffix = connection.prepare(`
              SELECT action.*, url.exact_url, consent.expires_at
              FROM live_acquisition_actions AS action
              JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
              JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
              WHERE action.consent_id = ? AND action.action_kind = 'page'
                AND action.state = 'planned' AND action.id <> ?
              ORDER BY action.depth, CAST(url.exact_url AS BLOB), action.id
              LIMIT 1000
            `).all(row.consent_id, row.id) as ActionRow[];
            for (const pending of suffix) {
              transition(pending, "blocked", "BUDGET_EXHAUSTED", {
                outcome_class: "blocked",
              }, at);
            }
            syncCheckpoint(read(actionId), at);
            rejection = error;
            return;
          }
          const resolving = read(actionId);
          try {
            validateCurrentPolicy(resolving, at);
          } catch (error) {
            transition(
              resolving,
              "blocked",
              error instanceof LiveAcquisitionActionPolicyError
                ? error.code
                : "POLICY_BLOCKED",
              { outcome_class: "blocked" },
              at,
            );
            rejection = error;
          }
        } else {
          validateCurrentPolicy(row, at);
          transition(row, "resolution_started", null, {}, at);
        }
        syncCheckpoint(read(actionId), at);
      });
      if (rejection !== undefined) throw rejection;
    },
    recordResolution(actionId, resolution) {
      immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "resolution_started") throw new Error("action is not resolving");
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        const answers: DnsAddressAnswer[] = resolution.normalizedAnswers.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }));
        const policy = classifyPublicDnsAnswers(answers);
        if (policy.kind === "blocked" || policy.selectedIpv4 !== resolution.selectedIpv4 ||
            policy.answerSetDigest !== resolution.answerSetDigest ||
            policy.selectedIpv4Digest !== resolution.selectedIpv4Digest) {
          throw new Error("DNS resolution commitment mismatch");
        }
        connection.prepare(`
          INSERT INTO live_acquisition_dns_payloads (
            action_id, answers_json, selected_ipv4, resolved_at
          ) VALUES (?, ?, ?, ?)
        `).run(actionId, JSON.stringify(resolution.normalizedAnswers), resolution.selectedIpv4, at);
        transition(row, "resolved", null, {
          address_digest: resolution.selectedIpv4Digest,
          dns_answer_count: resolution.normalizedAnswers.length,
        }, at);
      });
    },
    authorize(actionId) {
      return immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "resolved") throw new Error("only a resolved action may authorize");
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        const dns = connection.prepare(`
          SELECT answers_json, selected_ipv4 FROM live_acquisition_dns_payloads WHERE action_id = ?
        `).get(actionId) as { answers_json: string; selected_ipv4: string };
        const answers = (JSON.parse(dns.answers_json) as string[]).map((address) => ({
          address, family: address.includes(":") ? 6 as const : 4 as const,
        }));
        const publicAnswers = classifyPublicDnsAnswers(answers);
        if (publicAnswers.kind === "blocked" || publicAnswers.selectedIpv4 !== dns.selected_ipv4) {
          throw new Error("stored DNS resolution is not public");
        }
        const expiresAt = new Date(Math.min(Date.parse(row.expires_at), Date.parse(at) + 15_000))
          .toISOString();
        const authorizationDigest = sha256(JSON.stringify({
          actionId, runtimeEpoch: row.runtime_epoch,
          answerSetDigest: publicAnswers.answerSetDigest,
          selectedIpv4Digest: publicAnswers.selectedIpv4Digest,
          expiresAt,
        }));
        connection.prepare(`
          INSERT INTO live_acquisition_action_authorizations (
            action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
            authorized_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(actionId, row.runtime_epoch, publicAnswers.selectedIpv4Digest,
          authorizationDigest, at, expiresAt);
        transition(row, "authorized", null, {
          address_digest: publicAnswers.selectedIpv4Digest,
          dns_answer_count: publicAnswers.normalizedAnswers.length,
        }, at);
        return { authorizationDigest, expiresAt };
      });
    },
    start(actionId) {
      immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "authorized") throw new Error("only an authorized action may start");
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        validateAuthorizationExpiry(row, at);
        const courtesy = inspectCourtesy(row, at);
        commitCourtesyStart(row, at, courtesy);
        transition(row, "started", null, {}, at);
        syncCheckpoint(row, at);
      });
    },
    reserveRequest(actionId) {
      immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "authorized") throw new Error("only an authorized action may reserve");
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        validateAuthorizationExpiry(row, at);
        inspectCourtesy(row, at);
      });
    },
    block(actionId, code, ambiguous = false, retryAfter, visitedPage = false) {
      transact(() => {
        const row = read(actionId);
        if (["completed", "blocked", "ambiguous"].includes(row.state)) return;
        const at = canonicalTimestamp(clock);
        transition(row, ambiguous ? "ambiguous" : "blocked", code, {
          outcome_class: ambiguous ? "ambiguous" : "blocked",
          ...(visitedPage ? { response_class: "success" } : {}),
        }, at);
        if (row.action_kind === "page" && code === "HTTP_CLIENT_ERROR" &&
            row.state === "started") {
          const originDigest = sha256(new URL(row.exact_url).origin);
          const courtesy = connection.prepare(`
            SELECT coordinator_run_id, updated_at
            FROM live_acquisition_origin_courtesy_state
            WHERE consent_id = ? AND canonical_origin_digest = ?
          `).get(row.consent_id, originDigest) as {
            coordinator_run_id: number;
            updated_at: string;
          } | undefined;
          if (courtesy === undefined) {
            throw new Error("HTTP client error has no durable origin courtesy state");
          }
          const retryUntil = parseRetryAfter(
            retryAfter,
            new Date(at),
            new Date(row.expires_at),
          )?.toISOString() ?? row.expires_at;
          const updatedAt = nextUpdateTimestamp(at, courtesy.updated_at);
          connection.prepare(`
            UPDATE live_acquisition_origin_courtesy_state
            SET retry_after_until = ?, updated_at = ?
            WHERE coordinator_run_id = ? AND canonical_origin_digest = ?
          `).run(retryUntil, updatedAt, courtesy.coordinator_run_id, originDigest);
        }
        syncCheckpoint(row, at);
      });
    },
    blockForPrivacyPurgeAbort(actionId, provenance) {
      transact(() => {
        const requestDigest = provenance.requestDigest;
        const executionKeyDigest = provenance.executionKeyDigest;
        if (!/^[0-9a-f]{64}$/.test(requestDigest) ||
            !/^[0-9a-f]{64}$/.test(executionKeyDigest)) {
          throw new TypeError("invalid privacy purge abort provenance");
        }
        const row = read(actionId);
        if (row.state !== "started") {
          throw new Error("privacy purge abort requires a started action");
        }
        const at = canonicalTimestamp(clock);
        const safeDetails = {
          outcome_class: "ambiguous",
          abort_request_digest: requestDigest,
        };
        const eventId = Number(connection.prepare(`
          SELECT COALESCE(MAX(id), 0) + 1 FROM live_acquisition_action_events
        `).pluck().get());
        const eventRow = {
          id: eventId, action_id: actionId, sequence_no: row.sequence_no + 1,
          from_state: row.state, to_state: "ambiguous", outcome_code: "CANCELLED",
          safe_details_json: JSON.stringify(safeDetails), occurred_at: at,
        };
        const actionColumns = (connection.pragma(
          "table_info(live_acquisition_actions)",
        ) as Array<{ name: string }>).map(({ name }) => name);
        const actionRow = Object.fromEntries(actionColumns.map((name) => [
          name,
          name === "state" ? "ambiguous"
            : name === "sequence_no" ? row.sequence_no + 1
            : name === "terminal_at" ? at
            : (row as unknown as Record<string, unknown>)[name],
        ]));
        const integerPk = (value: number) => {
          const text = String(value);
          return `pk:v1|1|i:${text.length}:${text}`;
        };
        const commitAbort = () => {
          transition(row, "ambiguous", "CANCELLED", safeDetails, at);
          const base = {
            requestDigest, actionId, executionKeyDigest, eventId,
            eventSequenceNo: row.sequence_no + 1, recordedAt: at,
          };
          connection.prepare(`
            INSERT INTO live_acquisition_action_abort_provenance (
              request_digest, action_id, execution_key_digest, event_id,
              event_sequence_no, recorded_at, row_digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(requestDigest, actionId, executionKeyDigest, eventId,
            row.sequence_no + 1, at, sha256(JSON.stringify(base)));
        };
        if (options.authorizeOwnedMutation !== undefined) {
          commitAbort();
          return;
        }
        runWithPrivacyPurgeExternalAbortFence(connection, {
          requestDigest, actionId, executionKeyDigest,
        }, [{
          tableName: "live_acquisition_actions", operation: "UPDATE",
          oldPk: integerPk(actionId), newPk: integerPk(actionId),
          newRowDigest: sha256(JSON.stringify(actionRow)),
        }, {
          tableName: "live_acquisition_action_events", operation: "INSERT",
          oldPk: "", newPk: integerPk(eventId),
          newRowDigest: sha256(JSON.stringify(eventRow)),
        }], commitAbort);
      });
    },
    completePage(actionId, result) {
      return immediate(connection, () => {
        let row = read(actionId);
        if (row.state !== "started" || row.action_kind !== "page") {
          throw new Error("only a started page action may complete");
        }
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        validateAuthorizationExpiry(row, at);
        if (!/^[0-9a-f]{64}$/u.test(result.contentDigest) ||
            !/^[0-9a-f]{64}$/u.test(result.responseMetadataDigest) ||
            result.contentDigest !== sha256(result.rawBody)) {
          throw new TypeError("invalid content commitment");
        }
        if (row.logical_page_generation_id === null) {
          const parsed = new URL(row.exact_url);
          if (parsed.hash !== "") {
            throw new Error("live acquisition page identity must be fragmentless");
          }
          const logicalPage = createLogicalPageCatalog(connection, clock).resolve({
            observedAt: at,
            url: row.exact_url,
            urlNormalized: normalizeUrl(row.exact_url),
          });
          options.testOnlyMaterializationCheckpoint?.("logical_page");
          const resolution = createResourceCatalog(connection, clock)
            .resolvePage(logicalPage.id);
          options.testOnlyMaterializationCheckpoint?.("resource_resolution");
          const consentedResourceId = connection.prepare(`
            SELECT resource_id FROM privacy_subject_generations
            WHERE id = ? AND subject_kind = 'resource' AND is_active = 1
          `).pluck().get(row.resource_generation_id) as number | undefined;
          if (resolution.state !== "resolved" || consentedResourceId === undefined ||
              resolution.resource.id !== consentedResourceId ||
              resolution.candidateResourceIds.length !== 1 ||
              resolution.candidateResourceIds[0] !== consentedResourceId) {
            throw new LiveAcquisitionActionPolicyError(
              "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
            );
          }
          row = read(actionId);
          if (row.logical_page_generation_id === null) {
            throw new Error("live acquisition page materialization did not create a generation");
          }
          validateCurrentPolicy(row, at);
        }
        const terminalIdentity = connection.prepare(`
          SELECT page_generation.logical_page_id,
            resource_generation.resource_id AS consented_resource_id
          FROM privacy_subject_generations AS page_generation
          JOIN privacy_subject_generations AS resource_generation
            ON resource_generation.id = ? AND resource_generation.subject_kind = 'resource'
            AND resource_generation.is_active = 1
          WHERE page_generation.id = ? AND page_generation.subject_kind = 'logical_page'
            AND page_generation.is_active = 1
        `).get(row.resource_generation_id, row.logical_page_generation_id) as {
          logical_page_id: number;
          consented_resource_id: number;
        } | undefined;
        const terminalResolution = terminalIdentity === undefined
          ? undefined
          : createResourceCatalog(connection, clock)
              .getResolution(terminalIdentity.logical_page_id);
        if (terminalIdentity === undefined || terminalResolution?.state !== "resolved" ||
            terminalResolution.resource.id !== terminalIdentity.consented_resource_id ||
            terminalResolution.candidateResourceIds.length !== 1 ||
            terminalResolution.candidateResourceIds[0] !==
              terminalIdentity.consented_resource_id) {
          throw new LiveAcquisitionActionPolicyError(
            "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
          );
        }
        const bodyDigest = sha256(result.rawBody);
        connection.prepare(`
          INSERT INTO live_acquisition_body_payloads (
            action_id, raw_body, extracted_text, body_digest,
            response_metadata_json, acquired_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(actionId, Buffer.from(result.rawBody), result.extractedText, bodyDigest,
          JSON.stringify({ digest: result.responseMetadataDigest }), at);
        const captureOwner = connection.prepare(`
          SELECT url.keyed_url_digest AS url_digest,
            reservation.id AS reservation_id, action.depth,
            (SELECT COUNT(*) + 1 FROM live_acquisition_capture_manifests AS existing
             WHERE existing.consent_id = action.consent_id) AS capture_sequence
          FROM live_acquisition_actions AS action
          JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
          JOIN live_acquisition_page_reservations AS reservation
            ON reservation.action_id = action.id AND reservation.consent_id = action.consent_id
          WHERE action.id = ?
        `).get(actionId) as {
          url_digest: string;
          reservation_id: number;
          depth: number;
          capture_sequence: number;
        } | undefined;
        if (captureOwner === undefined) {
          throw new Error("started page action has no exact reservation");
        }
        connection.prepare(`
          INSERT INTO live_acquisition_capture_manifests (
            consent_id, logical_page_generation_id, action_id, reservation_id,
            depth, capture_sequence, url_digest, content_digest, manifest_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(row.consent_id, row.logical_page_generation_id, actionId,
          captureOwner.reservation_id, captureOwner.depth, captureOwner.capture_sequence,
          captureOwner.url_digest,
          result.contentDigest, JSON.stringify({
            url_digest: captureOwner.url_digest,
            content_digest: result.contentDigest,
            body_digest: bodyDigest,
            response_metadata_digest: result.responseMetadataDigest,
            response_class: "success",
            byte_length: result.rawBody.byteLength,
            redirect_count: 0,
            truncated: false,
          }), at);
        transition(row, "completed", "FETCH_COMPLETED", {
          content_digest: result.contentDigest,
          response_class: "success",
          response_bytes: result.rawBody.byteLength,
          redirect_count: 0,
          outcome_class: "completed",
        }, at);
        const discoveredLinks = result.discoveredLinks ?? [];
        if (!Array.isArray(discoveredLinks) || discoveredLinks.length > 200 ||
            discoveredLinks.some((link) => typeof link !== "string")) {
          throw new TypeError("invalid bounded discovered-link set");
        }
        const admittedActionIds: number[] = [];
        if (captureOwner.depth < 3 && discoveredLinks.length > 0) {
          const owner = connection.prepare(`
            SELECT payload.approved_origins_json,
              json_extract(consent.limits_json, '$.max_depth') AS max_depth,
              json_extract(consent.limits_json, '$.ruleset_generation_digest')
                AS frozen_ruleset_digest,
              json_extract(consent.limits_json, '$.resource_generation_digest')
                AS frozen_resource_generation_digest
            FROM live_acquisition_consents AS consent
            JOIN live_acquisition_consent_payloads AS payload
              ON payload.consent_id = consent.id
            WHERE consent.id = ?
          `).get(row.consent_id) as {
            approved_origins_json: string;
            max_depth: number;
            frozen_ruleset_digest: string;
            frozen_resource_generation_digest: string;
          };
          const approvedOrigins = new Set(JSON.parse(owner.approved_origins_json) as string[]);
          const canonical = new Map<string, ReturnType<typeof classifyLiveAcquisitionUrl> & {
            readonly kind: "allowed";
          }>();
          for (const rawLink of discoveredLinks) {
            const policy = classifyLiveAcquisitionUrl(rawLink);
            if (policy.kind !== "allowed" || !approvedOrigins.has(policy.canonicalOrigin)) continue;
            canonical.set(policy.canonicalFetchUrl, policy);
          }
          const ordered = [...canonical.values()].sort((left, right) =>
            Buffer.compare(Buffer.from(left.canonicalFetchUrl, "utf8"),
              Buffer.from(right.canonicalFetchUrl, "utf8")));
          for (const candidate of ordered) {
            if (captureOwner.depth + 1 > owner.max_depth) break;
            try {
              validateExactPageMembership({
                actionKind: "page",
                exactUrl: candidate.canonicalFetchUrl,
                resourceGenerationId: row.resource_generation_id,
                frozenRulesetDigest: owner.frozen_ruleset_digest,
                frozenResourceGenerationDigest: owner.frozen_resource_generation_digest,
              });
            } catch (error) {
              if (error instanceof LiveAcquisitionActionPolicyError) continue;
              throw error;
            }
            const robots = connection.prepare(`
              SELECT courtesy.robots_policy_digest, body.extracted_text
              FROM live_acquisition_actions AS action
              JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
              JOIN live_acquisition_body_payloads AS body ON body.action_id = action.id
              JOIN privacy_subject_generations AS generation
                ON generation.id = action.coordinator_run_generation_id
              JOIN live_acquisition_origin_courtesy_state AS courtesy
                ON courtesy.coordinator_run_id = generation.research_run_id
                AND courtesy.canonical_origin_digest = action.canonical_origin_digest
              WHERE action.consent_id = ? AND action.action_kind = 'robots'
                AND action.state = 'completed' AND url.exact_url = ?
            `).get(row.consent_id, `${candidate.canonicalOrigin}/robots.txt`) as {
              robots_policy_digest: string;
              extracted_text: string;
            } | undefined;
            if (robots === undefined) continue;
            const robotsPolicy = parseRobotsPolicy(robots.extracted_text);
            if (robotsPolicy.kind !== "parsed" ||
                robotsPolicy.policyDigest !== robots.robots_policy_digest ||
                !isRobotsPathAllowed(robotsPolicy, candidate.canonicalFetchUrl)) continue;
            const before = connection.prepare(`
              SELECT id FROM live_acquisition_actions
              WHERE coordinator_run_generation_id = ? AND action_kind = 'page'
                AND canonical_fetch_url_fingerprint = ?
            `).pluck().get(row.coordinator_run_generation_id, candidate.urlFingerprint);
            try {
              const planned = plan(row.consent_id, "page", null,
                candidate.canonicalFetchUrl, true, {
                  depth: captureOwner.depth + 1,
                  discoveredFromActionId: actionId,
                }, true);
              if (before === undefined) admittedActionIds.push(planned.id);
            } catch (error) {
              if (error instanceof Error && /admission budget exhausted|queue limit exceeded/u
                .test(error.message)) break;
              throw error;
            }
          }
        }
        syncCheckpoint(row, at);
        return Object.freeze({ admittedActionIds: Object.freeze(admittedActionIds) });
      });
    },
    completeRobots(actionId, result) {
      immediate(connection, () => {
        const row = read(actionId);
        if (row.state !== "started" || row.action_kind !== "robots" ||
            !/^[0-9a-f]{64}$/u.test(result.policyDigest) ||
            !Number.isSafeInteger(result.crawlDelayMs) ||
            result.crawlDelayMs < 2_000 || result.crawlDelayMs > 30_000) {
          throw new Error("only a started robots action with safe policy may complete");
        }
        const at = canonicalTimestamp(clock);
        validateCurrentPolicy(row, at);
        validateAuthorizationExpiry(row, at);
        const originDigest = sha256(new URL(row.exact_url).origin);
        const runId = connection.prepare(`
          SELECT research_run_id FROM privacy_subject_generations WHERE id = ?
        `).pluck().get(row.coordinator_run_generation_id) as number;
        const courtesy = connection.prepare(`
          SELECT last_request_at, updated_at FROM live_acquisition_origin_courtesy_state
          WHERE coordinator_run_id = ? AND canonical_origin_digest = ?
        `).get(runId, originDigest) as {
          last_request_at: string;
          updated_at: string;
        };
        const courtesyAt = nextUpdateTimestamp(at, courtesy.updated_at);
        const reparsed = parseRobotsPolicy(result.policyText);
        if (reparsed.kind !== "parsed" || reparsed.policyDigest !== result.policyDigest ||
            reparsed.crawlDelayMs !== result.crawlDelayMs) {
          throw new Error("robots policy evidence does not match commitment");
        }
        const policyBytes = new TextEncoder().encode(result.policyText === "" ? "\n" : result.policyText);
        connection.prepare(`
          INSERT INTO live_acquisition_body_payloads (
            action_id, raw_body, extracted_text, body_digest,
            response_metadata_json, acquired_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(actionId, Buffer.from(policyBytes), result.policyText === "" ? "\n" : result.policyText,
          sha256(policyBytes), JSON.stringify({ digest: result.policyDigest }), at);
        transition(row, "completed", "FETCH_COMPLETED", {
          response_class: "success",
          outcome_class: "completed",
          redirect_count: 0,
        }, at);
        connection.prepare(`
          UPDATE live_acquisition_origin_courtesy_state
          SET robots_policy_digest = ?, next_allowed_at = ?, updated_at = ?
          WHERE coordinator_run_id = ? AND canonical_origin_digest = ?
        `).run(result.policyDigest,
          new Date(Date.parse(courtesy.last_request_at) + result.crawlDelayMs).toISOString(),
          courtesyAt,
          runId, originDigest);
        syncCheckpoint(row, at);
      });
    },
    advanceRuntimeEpochAndRecover(writerEnabled) {
      return immediate(connection, () => {
        const clockAt = canonicalTimestamp(clock);
        const runtimeState = connection.prepare(`
          SELECT runtime_epoch, updated_at
          FROM live_acquisition_runtime_state WHERE singleton_id = 1
        `).get() as { runtime_epoch: number; updated_at: string };
        // Migration time and runtime time can legitimately come from different
        // clocks (notably deterministic app tests, or a host clock correction).
        // Keep the singleton authority monotonic while still advancing its epoch.
        const at = clockAt >= runtimeState.updated_at ? clockAt : runtimeState.updated_at;
        const currentEpoch = runtimeState.runtime_epoch;
        const runtimeEpoch = currentEpoch + 1;
        connection.prepare(`
          UPDATE live_acquisition_runtime_state
          SET runtime_epoch = ?, off_recovery_marker = 'pending', updated_at = ?
          WHERE singleton_id = 1 AND runtime_epoch = ?
        `).run(runtimeEpoch, at, currentEpoch);
        const rows = connection.prepare(`
          SELECT action.*, url.exact_url, consent.expires_at
          FROM live_acquisition_actions AS action
          JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
          JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
          WHERE action.runtime_epoch < ?
            AND action.state NOT IN ('completed', 'blocked', 'ambiguous')
          ORDER BY action.id
        `).all(runtimeEpoch) as ActionRow[];
        for (const row of rows) {
          if (row.state === "resolution_started") {
            transition(row, "ambiguous", "DNS_RESULT_UNKNOWN", {
              outcome_class: "ambiguous",
            }, at);
          } else if (row.state === "started") {
            transition(row, "ambiguous", "LIVE_ACQUISITION_DISABLED_IN_FLIGHT", {
              outcome_class: "ambiguous",
            }, at);
          } else if (row.state === "planned") {
            transition(row, "blocked", writerEnabled
              ? "RUNTIME_RESTARTED_BEFORE_REQUEST" : "LIVE_ACQUISITION_DISABLED", {
              outcome_class: "blocked",
            }, at);
          } else {
            transition(row, "blocked", "RUNTIME_RESTARTED_BEFORE_REQUEST", {
              outcome_class: "blocked",
            }, at);
          }
          syncCheckpoint(row, at, true);
        }
        const jobs = connection.prepare(`
          SELECT job.id, job.status, job.event_sequence, job.lease_token,
            job.updated_at, generation.id AS run_generation_id, consent.id AS consent_id,
            (SELECT attempt.id FROM ai_job_attempts AS attempt
             WHERE attempt.job_id = job.id AND attempt.outcome = 'running'
             ORDER BY attempt.attempt_no DESC LIMIT 1) AS attempt_id,
            EXISTS (
              SELECT 1 FROM live_acquisition_actions AS action
              WHERE action.coordinator_run_generation_id = generation.id
                AND action.state IN ('started', 'ambiguous')
            ) AS had_in_flight
          FROM ai_jobs AS job
          JOIN research_runs AS run ON run.job_id = job.id
          JOIN privacy_subject_generations AS generation
            ON generation.subject_kind = 'research_run'
            AND generation.research_run_id = run.id AND generation.is_active = 1
          JOIN live_acquisition_consents AS consent
            ON consent.coordinator_job_id = job.id
            AND consent.coordinator_run_generation_id = generation.id
          WHERE job.kind = 'resource_research'
            AND job.workflow_id = 'research_acquisition:c90:v1'
            AND job.workflow_version = 1
            AND job.status IN ('queued', 'running')
            AND consent.runtime_epoch < ?
          ORDER BY job.id
        `).all(runtimeEpoch) as Array<{
          id: number;
          status: "queued" | "running";
          event_sequence: number;
          lease_token: string | null;
          updated_at: string;
          run_generation_id: number;
          consent_id: number;
          attempt_id: number | null;
          had_in_flight: 0 | 1;
        }>;
        const supersedeJob = connection.prepare(`
          INSERT INTO ai_job_events (
            job_id, sequence_no, event_type, from_status, to_status,
            attempt_id, lease_token, occurred_at
          ) VALUES (?, ?, 'superseded', ?, 'superseded', ?, ?, ?)
        `);
        const insertOutcome = connection.prepare(`
          INSERT INTO live_acquisition_workflow_outcomes (
            coordinator_job_id, coordinator_run_generation_id, outcome,
            outcome_code, safe_details_json, created_at
          ) VALUES (?, ?, 'superseded', ?, ?, ?)
        `);
        for (const job of jobs) {
          if (job.status === "running" &&
              (job.attempt_id === null || job.lease_token === null)) {
            throw new Error("C90 off recovery lost its exact attempt fence");
          }
          const terminalAt = at >= job.updated_at ? at : job.updated_at;
          supersedeJob.run(
            job.id,
            job.event_sequence + 1,
            job.status,
            job.status === "running" ? job.attempt_id : null,
            job.status === "running" ? job.lease_token : null,
            terminalAt,
          );
          insertOutcome.run(
            job.id,
            job.run_generation_id,
            job.had_in_flight === 1
              ? "LIVE_ACQUISITION_DISABLED_IN_FLIGHT"
              : "LIVE_ACQUISITION_DISABLED",
            JSON.stringify({
              outcome_class: job.had_in_flight === 1 ? "ambiguous" : "blocked",
              attempt_count: job.status === "running" ? 1 : 0,
            }),
            terminalAt,
          );
          connection.prepare(`
            UPDATE live_acquisition_consents
            SET status = 'revoked', terminal_at = ?
            WHERE id = ? AND status = 'active'
          `).run(terminalAt, job.consent_id);
        }
        let releasedReservations = 0;
        if (!writerEnabled) {
          const finalJobs = connection.prepare(`
            SELECT reservation.id AS reservation_id, final_job.id,
              final_job.status, final_job.event_sequence, final_job.lease_token,
              final_job.updated_at,
              (SELECT attempt.id FROM ai_job_attempts AS attempt
               WHERE attempt.job_id = final_job.id AND attempt.outcome = 'running'
               ORDER BY attempt.attempt_no DESC, attempt.id DESC LIMIT 1) AS attempt_id
            FROM live_acquisition_provider_reservations AS reservation
            JOIN live_acquisition_handoffs AS handoff ON handoff.id = reservation.handoff_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = handoff.coordinator_run_generation_id
            JOIN research_runs AS coordinator_run
              ON coordinator_run.id = generation.research_run_id
            JOIN ai_jobs AS coordinator_job ON coordinator_job.id = coordinator_run.job_id
            JOIN ai_jobs AS final_job ON final_job.id = reservation.final_job_id
            WHERE reservation.status = 'active'
              AND coordinator_job.workflow_id = 'research_acquisition:c90:v1'
              AND coordinator_job.workflow_version = 1
            ORDER BY reservation.id
          `).all() as Array<{
            reservation_id: number;
            id: number;
            status: string;
            event_sequence: number;
            lease_token: string | null;
            updated_at: string;
            attempt_id: number | null;
          }>;
          for (const finalJob of finalJobs) {
            if (finalJob.status !== "queued" && finalJob.status !== "running") {
              throw new Error("active provider reservation has no recoverable final job");
            }
            if (finalJob.status === "running" &&
                (finalJob.attempt_id === null || finalJob.lease_token === null)) {
              throw new Error("provider reservation recovery lost its exact final attempt fence");
            }
            const terminalAt = at >= finalJob.updated_at ? at : finalJob.updated_at;
            supersedeJob.run(
              finalJob.id,
              finalJob.event_sequence + 1,
              finalJob.status,
              finalJob.status === "running" ? finalJob.attempt_id : null,
              finalJob.status === "running" ? finalJob.lease_token : null,
              terminalAt,
            );
            const terminalStatus = connection.prepare(`
              SELECT status FROM live_acquisition_provider_reservations WHERE id = ?
            `).pluck().get(finalJob.reservation_id) as string;
            if (terminalStatus === "active") {
              throw new Error("terminal final job did not close its provider reservation");
            }
            if (terminalStatus === "released") releasedReservations += 1;
          }
        }
        connection.prepare(`
          UPDATE live_acquisition_runtime_state
          SET off_recovery_marker = 'completed', updated_at = ?
          WHERE singleton_id = 1 AND runtime_epoch = ?
        `).run(at, runtimeEpoch);
        return {
          runtimeEpoch,
          recoveredActions: rows.length,
          recoveredJobs: jobs.length,
          releasedReservations,
        };
      });
    },
    read,
  };
  return Object.freeze(ledger);
}
