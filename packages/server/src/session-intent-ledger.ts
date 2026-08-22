import type Database from "better-sqlite3";

import {
  modelProvenanceSchema,
  shareableSessionIntentBundleSchema,
  shareableSessionIntentSchema,
  sessionIntentBundleSchema,
  sessionIntentPageSchema,
  sessionIntentSchema,
  type ContextEntry,
  type ExactTabScope,
  type ModelProvenance,
  type SessionIntent,
  type SessionIntentBundle,
  type SessionIntentChangeResult,
  type SessionIntentCommand,
  type SessionIntentPage,
  type SessionIntentProvenance,
  type SessionIntentQuery,
  type ShareableSessionIntentBundle,
  type ShareableSessionIntent,
} from "@tabhub/shared";

import type { ContextLedger } from "./context-ledger.js";

export type SessionIntentLedgerErrorCode =
  | "SESSION_SCOPE_STALE"
  | "SESSION_INTENT_NOT_FOUND"
  | "SESSION_INTENT_STATE_INVALID"
  | "SESSION_INTENT_SUBJECT_MISMATCH"
  | "IDEMPOTENCY_KEY_CONFLICT";

const sessionIntentErrorMessages: Record<
  SessionIntentLedgerErrorCode,
  string
> = {
  SESSION_SCOPE_STALE: "Physical tab scope no longer matches the expected page",
  SESSION_INTENT_NOT_FOUND: "Session intent not found",
  SESSION_INTENT_STATE_INVALID: "Session intent is not in the required state",
  SESSION_INTENT_SUBJECT_MISMATCH: "Session intent belongs to a different page",
  IDEMPOTENCY_KEY_CONFLICT: "Idempotency key was already used for another command",
};

export class SessionIntentLedgerError extends Error {
  constructor(readonly code: SessionIntentLedgerErrorCode) {
    super(sessionIntentErrorMessages[code]);
    this.name = "SessionIntentLedgerError";
  }
}

export interface SessionIntentLedger {
  readLocal(scope: ExactTabScope): SessionIntentBundle;
  readShareable(scope: ExactTabScope): ShareableSessionIntentBundle;
  listLocal(query: SessionIntentQuery): SessionIntentPage;
  change(command: SessionIntentCommand): SessionIntentChangeResult;
  purgeExpired(input: { before: string }): { purged: number };
  reconcilePhysicalScopes(input: { at: string }): { archived: number };
}

export interface SessionIntentReconciler {
  reconcilePhysicalScopes(input: { at: string }): { archived: number };
}

export interface SessionIntentLedgerTestHooks {
  afterArchiveBeforeSet?: () => void;
  afterContextPromotion?: () => void;
}

export interface SessionIntentLedgerOptions {
  now?: () => string;
  testHooks?: SessionIntentLedgerTestHooks;
}

interface SessionIntentRow {
  id: number;
  installation_id: string;
  browser_session_id: string;
  browser_tab_id: number;
  logical_page_id: number;
  expected_url: string;
  expected_url_normalized: string;
  expected_instance_revision: number;
  body: string;
  actor: "user" | "agent";
  method: "manual" | "on_behalf_of_user" | "model";
  visibility: SessionIntent["visibility"];
  confidence: number | null;
  source_fingerprint: string | null;
  model_provenance_json: string | null;
  stale_at: string | null;
  state: SessionIntent["state"];
  idempotency_key: string;
  archive_idempotency_key: string | null;
  archive_cause: "explicit" | "navigation" | "replacement" | null;
  replacement_idempotency_key: string | null;
  promote_idempotency_key: string | null;
  archived_at: string | null;
  expires_at: string | null;
  promoted_context_entry_id: number | null;
  created_at: string;
  updated_at: string;
}

interface PhysicalPageRow {
  logical_page_id: number;
  url: string;
  url_normalized: string;
  instance_revision: number;
}

type ReplacementOutcome =
  | { kind: "visible_successor"; row: SessionIntentRow }
  | { kind: "terminal"; row: SessionIntentRow }
  | { kind: "missing_or_cyclic" };

function modelJson(provenance: SessionIntentProvenance): string | null {
  return provenance.actor === "agent" && provenance.method === "model"
    ? JSON.stringify(provenance.model)
    : null;
}

function sourceFingerprint(
  provenance: SessionIntentProvenance,
): string | null {
  return "sourceFingerprint" in provenance
    ? (provenance.sourceFingerprint ?? null)
    : null;
}

function confidence(provenance: SessionIntentProvenance): number | null {
  return "confidence" in provenance ? (provenance.confidence ?? null) : null;
}

function storedModelProvenance(modelJson: string): ModelProvenance {
  try {
    return modelProvenanceSchema.parse(JSON.parse(modelJson));
  } catch {
    throw new Error(
      "Stored session intent provenance violates schema invariants",
    );
  }
}

function provenanceFromRow(row: SessionIntentRow): SessionIntentProvenance {
  if (
    row.actor === "user" &&
    row.method === "manual" &&
    row.confidence === null &&
    row.source_fingerprint === null &&
    row.model_provenance_json === null
  ) {
    return { actor: "user", method: "manual" };
  }
  if (
    row.actor === "agent" &&
    row.method === "on_behalf_of_user" &&
    row.confidence === null &&
    row.source_fingerprint === null &&
    row.model_provenance_json === null
  ) {
    return { actor: "agent", method: "on_behalf_of_user" };
  }
  if (
    row.actor === "agent" &&
    row.method === "model" &&
    row.source_fingerprint !== null &&
    row.model_provenance_json !== null
  ) {
    return {
      actor: "agent",
      method: "model",
      sourceFingerprint: row.source_fingerprint,
      model: storedModelProvenance(row.model_provenance_json),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
    };
  }
  throw new Error("Stored session intent provenance violates schema invariants");
}

function intentFromRow(row: SessionIntentRow): SessionIntent {
  return sessionIntentSchema.parse({
    id: row.id,
    scope: {
      installationId: row.installation_id,
      browserSessionId: row.browser_session_id,
      browserTabId: row.browser_tab_id,
    },
    subject: { type: "page", logicalPageId: row.logical_page_id },
    expectedPage: {
      logicalPageId: row.logical_page_id,
      url: row.expected_url,
      urlNormalized: row.expected_url_normalized,
      instanceRevision: row.expected_instance_revision,
    },
    body: row.body,
    provenance: provenanceFromRow(row),
    visibility: row.visibility,
    staleAt: row.stale_at,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
    promotedContextEntryId: row.promoted_context_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function originalSetIntentFromRow(row: SessionIntentRow): SessionIntent {
  return intentFromRow({
    ...row,
    state: "active",
    archive_idempotency_key: null,
    archive_cause: null,
    replacement_idempotency_key: null,
    promote_idempotency_key: null,
    archived_at: null,
    expires_at: null,
    promoted_context_entry_id: null,
    updated_at: row.created_at,
  });
}

function originalArchiveIntentFromRow(row: SessionIntentRow): SessionIntent {
  if (row.archived_at === null || row.expires_at === null) {
    throw new Error("Stored archive receipt violates schema invariants");
  }
  return intentFromRow({
    ...row,
    state: "archived",
    promote_idempotency_key: null,
    promoted_context_entry_id: null,
    updated_at: row.archived_at,
  });
}

function shareableIntentFromRow(row: SessionIntentRow): ShareableSessionIntent {
  return shareableSessionIntentSchema.parse({
    scope: {
      installationId: row.installation_id,
      browserSessionId: row.browser_session_id,
      browserTabId: row.browser_tab_id,
    },
    subject: { type: "page", logicalPageId: row.logical_page_id },
    expectedPage: {
      logicalPageId: row.logical_page_id,
      url: row.expected_url,
      urlNormalized: row.expected_url_normalized,
      instanceRevision: row.expected_instance_revision,
    },
    body: row.body,
    provenance: provenanceFromRow(row),
    visibility: "share_with_ai",
    staleAt: row.stale_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function sameProvenance(
  row: SessionIntentRow,
  provenance: SessionIntentProvenance,
): boolean {
  return (
    row.actor === provenance.actor &&
    row.method === provenance.method &&
    row.source_fingerprint === sourceFingerprint(provenance) &&
    row.confidence === confidence(provenance) &&
    row.model_provenance_json === modelJson(provenance)
  );
}

function plusThirtyDays(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

function replacementOutcomeFrom(
  row: SessionIntentRow,
  bySetKey: ReadonlyMap<string, SessionIntentRow>,
): ReplacementOutcome {
  if (row.replacement_idempotency_key === null) {
    return { kind: "missing_or_cyclic" };
  }
  let replacement = bySetKey.get(row.replacement_idempotency_key);
  const visited = new Set<number>([row.id]);
  while (replacement !== undefined && !visited.has(replacement.id)) {
    visited.add(replacement.id);
    if (replacement.visibility === "share_with_ai") {
      return { kind: "visible_successor", row: replacement };
    }
    if (
      replacement.archive_cause === "replacement" &&
      replacement.replacement_idempotency_key !== null
    ) {
      replacement = bySetKey.get(replacement.replacement_idempotency_key);
      continue;
    }
    return { kind: "terminal", row: replacement };
  }
  return { kind: "missing_or_cyclic" };
}

function effectiveIntentExpiry(
  rows: SessionIntentRow[],
): (row: SessionIntentRow) => string | null {
  const bySetKey = new Map(rows.map((row) => [row.idempotency_key, row]));
  return (row) => {
    if (row.visibility === "local_only") {
      return row.expires_at;
    }
    if (
      row.archive_cause !== "replacement" ||
      row.replacement_idempotency_key === null
    ) {
      return row.expires_at;
    }
    const outcome = replacementOutcomeFrom(row, bySetKey);
    if (outcome.kind === "visible_successor") {
      return plusThirtyDays(outcome.row.created_at);
    }
    if (
      outcome.kind === "terminal" &&
      outcome.row.archive_cause === "navigation"
    ) {
      return outcome.row.expires_at;
    }
    return null;
  };
}

export function createSessionIntentReconciler(
  connection: Database.Database,
): SessionIntentReconciler {
  const reconcile = connection.prepare(`
    UPDATE tab_session_intents
    SET state = 'archived',
        archive_idempotency_key = 'navigation:' || id || ':' || @at,
        archive_cause = 'navigation',
        replacement_idempotency_key = NULL,
        archived_at = @at,
        expires_at = @expiresAt,
        updated_at = @at
    WHERE state = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM tab_instances
        JOIN tabs ON tabs.id = tab_instances.tab_id
        WHERE tab_instances.installation_id = tab_session_intents.installation_id
          AND tab_instances.browser_session_id = tab_session_intents.browser_session_id
          AND tab_instances.browser_tab_id = tab_session_intents.browser_tab_id
          AND tabs.logical_page_id = tab_session_intents.logical_page_id
          AND tab_instances.url = tab_session_intents.expected_url
          AND tabs.url_normalized = tab_session_intents.expected_url_normalized
          AND tab_instances.navigation_revision =
            tab_session_intents.expected_instance_revision
      )
  `);
  const reconcilePhysicalScopes = ({ at }: { at: string }) => {
    const operation = () => ({
      archived: reconcile.run({ at, expiresAt: plusThirtyDays(at) }).changes,
    });
    return connection.inTransaction
      ? operation()
      : connection.transaction(operation)();
  };
  return { reconcilePhysicalScopes };
}

export function createSessionIntentLedger(
  connection: Database.Database,
  contextLedger: ContextLedger,
  options: SessionIntentLedgerOptions = {},
): SessionIntentLedger {
  const now = options.now ?? (() => new Date().toISOString());
  const atomically = <Result>(operation: () => Result): Result =>
    connection.inTransaction
      ? operation()
      : connection.transaction(operation)();

  const selectIntent = connection.prepare(
    "SELECT * FROM tab_session_intents WHERE id = ?",
  );
  const selectBySetKey = connection.prepare(
    "SELECT * FROM tab_session_intents WHERE idempotency_key = ?",
  );
  const selectByArchiveKey = connection.prepare(
    "SELECT * FROM tab_session_intents WHERE archive_idempotency_key = ?",
  );
  const selectByPromoteKey = connection.prepare(
    "SELECT * FROM tab_session_intents WHERE promote_idempotency_key = ?",
  );
  const selectPhysicalPage = connection.prepare(`
    SELECT
      tabs.logical_page_id,
      tab_instances.url,
      tabs.url_normalized,
      tab_instances.navigation_revision AS instance_revision
    FROM tab_instances
    JOIN tabs ON tabs.id = tab_instances.tab_id
    WHERE tab_instances.installation_id = ?
      AND tab_instances.browser_session_id = ?
      AND tab_instances.browser_tab_id = ?
    ORDER BY tab_instances.id DESC
    LIMIT 1
  `);
  const selectScopeHistory = connection.prepare(`
    SELECT *
    FROM tab_session_intents
    WHERE installation_id = ?
      AND browser_session_id = ?
      AND browser_tab_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const selectAllIntentHistory = connection.prepare(`
    SELECT * FROM tab_session_intents ORDER BY id
  `);
  const selectActiveScopeIntent = connection.prepare(`
    SELECT *
    FROM tab_session_intents
    WHERE installation_id = ?
      AND browser_session_id = ?
      AND browser_tab_id = ?
      AND state = 'active'
    LIMIT 1
  `);
  const insertIntent = connection.prepare(`
    INSERT INTO tab_session_intents (
      installation_id, browser_session_id, browser_tab_id, logical_page_id,
      expected_url, expected_url_normalized, expected_instance_revision,
      body, actor, method, visibility, confidence, source_fingerprint,
      model_provenance_json, stale_at, state, idempotency_key,
      archive_idempotency_key, promote_idempotency_key, archived_at,
      archive_cause, replacement_idempotency_key, expires_at,
      promoted_context_entry_id, created_at, updated_at
    ) VALUES (
      @installationId, @browserSessionId, @browserTabId, @logicalPageId,
      @expectedUrl, @expectedUrlNormalized, @expectedInstanceRevision,
      @body, @actor, @method, @visibility, @confidence, @sourceFingerprint,
      @modelProvenanceJson, @staleAt, 'active', @idempotencyKey,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, @createdAt, @createdAt
    )
  `);
  const archiveIntent = connection.prepare(`
    UPDATE tab_session_intents
    SET state = 'archived',
        archive_idempotency_key = @idempotencyKey,
        archive_cause = @archiveCause,
        replacement_idempotency_key = @replacementIdempotencyKey,
        archived_at = @archivedAt,
        expires_at = @expiresAt,
        updated_at = @archivedAt
    WHERE id = @intentId AND state = 'active'
  `);
  const promoteIntent = connection.prepare(`
    UPDATE tab_session_intents
    SET state = 'promoted',
        promote_idempotency_key = @idempotencyKey,
        promoted_context_entry_id = @contextEntryId,
        replacement_idempotency_key = NULL,
        updated_at = @updatedAt
    WHERE id = @intentId AND state IN ('active', 'archived')
  `);

  const requireIntent = (id: number): SessionIntentRow => {
    const intent = selectIntent.get(id) as SessionIntentRow | undefined;
    if (intent === undefined) {
      throw new SessionIntentLedgerError("SESSION_INTENT_NOT_FOUND");
    }
    return intent;
  };

  const keyUse = (
    key: string,
  ): { operation: "set" | "archive" | "promote"; row: SessionIntentRow } | null => {
    const set = selectBySetKey.get(key) as SessionIntentRow | undefined;
    if (set !== undefined) return { operation: "set", row: set };
    const archive = selectByArchiveKey.get(key) as SessionIntentRow | undefined;
    if (archive !== undefined) return { operation: "archive", row: archive };
    const promote = selectByPromoteKey.get(key) as SessionIntentRow | undefined;
    return promote === undefined ? null : { operation: "promote", row: promote };
  };

  const physicalPage = (scope: ExactTabScope): PhysicalPageRow | undefined =>
    selectPhysicalPage.get(
      scope.installationId,
      scope.browserSessionId,
      scope.browserTabId,
    ) as PhysicalPageRow | undefined;

  const matchesPhysicalPage = (
    intent: SessionIntentRow,
    physical: PhysicalPageRow | undefined,
  ): boolean =>
    physical !== undefined &&
    intent.logical_page_id === physical.logical_page_id &&
    intent.expected_url === physical.url &&
    intent.expected_url_normalized === physical.url_normalized &&
    intent.expected_instance_revision === physical.instance_revision;

  const validateExpectedPage = (
    command: Extract<SessionIntentCommand, { kind: "set" }>,
  ): PhysicalPageRow => {
    const physical = physicalPage(command.scope);
    if (
      physical === undefined ||
      physical.logical_page_id !== command.expectedPage.logicalPageId ||
      physical.url !== command.expectedPage.url ||
      physical.url_normalized !== command.expectedPage.urlNormalized ||
      physical.instance_revision !== command.expectedPage.instanceRevision
    ) {
      throw new SessionIntentLedgerError("SESSION_SCOPE_STALE");
    }
    return physical;
  };

  const bundle = (scope: ExactTabScope): SessionIntentBundle => {
    const rows = selectScopeHistory.all(
      scope.installationId,
      scope.browserSessionId,
      scope.browserTabId,
    ) as SessionIntentRow[];
    const physical = physicalPage(scope);
    const currentRow = rows.find(
      (row) => row.state === "active" && matchesPhysicalPage(row, physical),
    );
    return sessionIntentBundleSchema.parse({
      scope,
      current: currentRow === undefined ? null : intentFromRow(currentRow),
      history: rows.map(intentFromRow),
    });
  };

  const shareableBundle = (
    scope: ExactTabScope,
  ): ShareableSessionIntentBundle => {
    const allRows = selectScopeHistory.all(
      scope.installationId,
      scope.browserSessionId,
      scope.browserTabId,
    ) as SessionIntentRow[];
    const rows = allRows.filter(
      (row) => row.visibility === "share_with_ai",
    );
    const physical = physicalPage(scope);
    const bySetKey = new Map(allRows.map((row) => [row.idempotency_key, row]));
    const projectedRows = rows.map((row) => {
      if (
        (row.state !== "archived" && row.state !== "expired") ||
        row.archive_cause !== "replacement" ||
        row.replacement_idempotency_key === null
      ) {
        return row;
      }
      const outcome = replacementOutcomeFrom(row, bySetKey);
      if (outcome.kind === "visible_successor") {
        const effectiveArchivedAt = outcome.row.created_at;
        return {
          ...row,
          state: row.state === "expired" ? "expired" as const : "archived" as const,
          archived_at: effectiveArchivedAt,
          expires_at: plusThirtyDays(effectiveArchivedAt),
          updated_at:
            row.state === "expired" ? row.updated_at : effectiveArchivedAt,
        };
      }
      if (
        outcome.kind === "terminal" &&
        outcome.row.archive_cause === "navigation"
      ) {
        return {
          ...row,
          state: outcome.row.state,
          archived_at: outcome.row.archived_at,
          expires_at: outcome.row.expires_at,
          updated_at: outcome.row.updated_at,
        };
      }
      return {
        ...row,
        state: "active" as const,
        archived_at: null,
        expires_at: null,
        updated_at: row.created_at,
      };
    });
    const currentRow = projectedRows.find(
      (row) => row.state === "active" && matchesPhysicalPage(row, physical),
    );
    return shareableSessionIntentBundleSchema.parse({
      scope,
      current:
        currentRow === undefined ? null : shareableIntentFromRow(currentRow),
      history: projectedRows.map(shareableIntentFromRow),
    });
  };

  const archiveRow = (
    row: SessionIntentRow,
    idempotencyKey: string,
    archivedAt: string,
    archiveCause: "explicit" | "navigation" | "replacement",
    replacementIdempotencyKey: string | null = null,
  ): SessionIntentRow => {
    const result = archiveIntent.run({
      intentId: row.id,
      idempotencyKey,
      archivedAt,
      expiresAt: plusThirtyDays(archivedAt),
      archiveCause,
      replacementIdempotencyKey,
    });
    if (result.changes !== 1) {
      throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
    }
    return requireIntent(row.id);
  };

  const setIntent = (
    command: Extract<SessionIntentCommand, { kind: "set" }>,
  ): SessionIntentChangeResult =>
    atomically(() => {
      const used = keyUse(command.idempotencyKey);
      if (used !== null) {
        const row = used.row;
        const same =
          used.operation === "set" &&
          row.installation_id === command.scope.installationId &&
          row.browser_session_id === command.scope.browserSessionId &&
          row.browser_tab_id === command.scope.browserTabId &&
          row.logical_page_id === command.expectedPage.logicalPageId &&
          row.expected_url === command.expectedPage.url &&
          row.expected_url_normalized === command.expectedPage.urlNormalized &&
          row.expected_instance_revision === command.expectedPage.instanceRevision &&
          row.body === command.body &&
          row.visibility === command.visibility &&
          row.stale_at === (command.staleAt ?? null) &&
          sameProvenance(row, command.provenance);
        if (!same) {
          throw new SessionIntentLedgerError("IDEMPOTENCY_KEY_CONFLICT");
        }
        return { kind: "set", intent: originalSetIntentFromRow(row) };
      }

      validateExpectedPage(command);
      const previous = selectActiveScopeIntent.get(
        command.scope.installationId,
        command.scope.browserSessionId,
        command.scope.browserTabId,
      ) as SessionIntentRow | undefined;
      const createdAt = now();
      if (previous !== undefined) {
        archiveRow(
          previous,
          `replacement:${command.idempotencyKey}`,
          createdAt,
          "replacement",
          command.idempotencyKey,
        );
        options.testHooks?.afterArchiveBeforeSet?.();
      }
      const inserted = insertIntent.run({
        installationId: command.scope.installationId,
        browserSessionId: command.scope.browserSessionId,
        browserTabId: command.scope.browserTabId,
        logicalPageId: command.expectedPage.logicalPageId,
        expectedUrl: command.expectedPage.url,
        expectedUrlNormalized: command.expectedPage.urlNormalized,
        expectedInstanceRevision: command.expectedPage.instanceRevision,
        body: command.body,
        actor: command.provenance.actor,
        method: command.provenance.method,
        visibility: command.visibility,
        confidence: confidence(command.provenance),
        sourceFingerprint: sourceFingerprint(command.provenance),
        modelProvenanceJson: modelJson(command.provenance),
        staleAt: command.staleAt ?? null,
        idempotencyKey: command.idempotencyKey,
        createdAt,
      });
      return {
        kind: "set",
        intent: intentFromRow(requireIntent(Number(inserted.lastInsertRowid))),
      };
    });

  const archive = (
    command: Extract<SessionIntentCommand, { kind: "archive" }>,
  ): SessionIntentChangeResult =>
    atomically(() => {
      const used = keyUse(command.idempotencyKey);
      if (used !== null) {
        if (used.operation !== "archive" || used.row.id !== command.intentId) {
          throw new SessionIntentLedgerError("IDEMPOTENCY_KEY_CONFLICT");
        }
        return {
          kind: "archived",
          intent: originalArchiveIntentFromRow(used.row),
        };
      }
      const intent = requireIntent(command.intentId);
      if (intent.state !== "active") {
        throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
      }
      return {
        kind: "archived",
        intent: intentFromRow(
          archiveRow(intent, command.idempotencyKey, now(), "explicit"),
        ),
      };
    });

  const contextEntry = (
    logicalPageId: number,
    entryId: number,
  ): ContextEntry => {
    const entry = contextLedger
      .readLocal({ type: "page", logicalPageId })
      .entries.find(({ id }) => id === entryId);
    if (entry === undefined) {
      throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
    }
    return entry;
  };

  const promote = (
    command: Extract<SessionIntentCommand, { kind: "promote" }>,
  ): SessionIntentChangeResult =>
    atomically(() => {
      const used = keyUse(command.idempotencyKey);
      if (used !== null) {
        const row = used.row;
        const linked =
          row.promoted_context_entry_id === null
            ? undefined
            : contextEntry(row.logical_page_id, row.promoted_context_entry_id);
        if (
          used.operation !== "promote" ||
          row.id !== command.intentId ||
          row.logical_page_id !== command.subject.logicalPageId ||
          linked?.entryKind !== command.contextKind
        ) {
          throw new SessionIntentLedgerError("IDEMPOTENCY_KEY_CONFLICT");
        }
        return {
          kind: "promoted",
          intent: intentFromRow(row),
          context: { ...linked, currentReview: null },
        };
      }

      const intent = requireIntent(command.intentId);
      if (intent.logical_page_id !== command.subject.logicalPageId) {
        throw new SessionIntentLedgerError("SESSION_INTENT_SUBJECT_MISMATCH");
      }
      if (
        intent.state !== "active" &&
        (intent.state !== "archived" ||
          intent.expires_at === null ||
          intent.expires_at <= now())
      ) {
        throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
      }
      const contextResult = contextLedger.change({
        kind: "append",
        subject: command.subject,
        entryKind: command.contextKind,
        body: intent.body,
        provenance: provenanceFromRow(intent),
        visibility: intent.visibility,
        staleAt: intent.stale_at,
        idempotencyKey: `session-intent-promote:${command.idempotencyKey}`,
      });
      if (contextResult.kind !== "changed") {
        throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
      }
      options.testHooks?.afterContextPromotion?.();
      const updatedAt = now();
      const result = promoteIntent.run({
        intentId: intent.id,
        idempotencyKey: command.idempotencyKey,
        contextEntryId: contextResult.entry.id,
        updatedAt,
      });
      if (result.changes !== 1) {
        throw new SessionIntentLedgerError("SESSION_INTENT_STATE_INVALID");
      }
      return {
        kind: "promoted",
        intent: intentFromRow(requireIntent(intent.id)),
        context: contextResult.entry,
      };
    });

  const expireDue = (
    command: Extract<SessionIntentCommand, { kind: "expire_due" }>,
  ): SessionIntentChangeResult =>
    atomically(() => {
      const rows = selectAllIntentHistory.all() as SessionIntentRow[];
      const effectiveExpiry = effectiveIntentExpiry(rows);
      const due = rows
        .filter(
          (row) =>
            row.state === "archived" &&
            effectiveExpiry(row) !== null &&
            effectiveExpiry(row)! <= command.now,
        )
        .map(({ id }) => id);
      const expireIntent = connection.prepare(`
        UPDATE tab_session_intents
        SET state = 'expired', updated_at = ?
        WHERE id = ? AND state = 'archived'
      `);
      for (const id of due) {
        expireIntent.run(command.now, id);
      }
      return { kind: "expired", intentIds: due };
    });

  const listLocal = (query: SessionIntentQuery): SessionIntentPage => {
    const predicates: string[] = [];
    const parameters: Record<string, unknown> = {
      logicalPageId: query.logicalPageId ?? null,
      state: query.state ?? null,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    };
    if (query.logicalPageId !== undefined) {
      predicates.push("logical_page_id = @logicalPageId");
    }
    if (query.state !== undefined) {
      predicates.push("state = @state");
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    const total = Number(
      connection
        .prepare(`SELECT COUNT(*) FROM tab_session_intents ${where}`)
        .pluck()
        .get(parameters),
    );
    const rows = connection
      .prepare(`
        SELECT *
        FROM tab_session_intents
        ${where}
        ORDER BY updated_at DESC, id DESC
        LIMIT @limit OFFSET @offset
      `)
      .all(parameters) as SessionIntentRow[];
    return sessionIntentPageSchema.parse({
      items: rows.map(intentFromRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  };

  return {
    readLocal: bundle,
    readShareable: shareableBundle,
    listLocal,
    change: (command) => {
      switch (command.kind) {
        case "set":
          return setIntent(command);
        case "archive":
          return archive(command);
        case "promote":
          return promote(command);
        case "expire_due":
          return expireDue(command);
      }
    },
    purgeExpired: ({ before }) =>
      atomically(() => {
        const rows = selectAllIntentHistory.all() as SessionIntentRow[];
        const reviveVisibleIntent = connection.prepare(`
          UPDATE tab_session_intents
          SET state = 'active', archive_idempotency_key = NULL,
              archive_cause = NULL, replacement_idempotency_key = NULL,
              archived_at = NULL, expires_at = NULL, updated_at = created_at
          WHERE id = ? AND state IN ('archived', 'expired')
            AND archive_cause = 'replacement'
        `);
        const selectInboundReplacement = connection.prepare(`
          SELECT * FROM tab_session_intents
          WHERE replacement_idempotency_key = ?
          ORDER BY id
        `);
        const rewireReplacement = connection.prepare(`
          UPDATE tab_session_intents
          SET replacement_idempotency_key = ?
          WHERE id = ? AND replacement_idempotency_key = ?
        `);
        const effectiveExpiry = effectiveIntentExpiry(rows);
        const due = rows.filter(
          (row) =>
            row.state === "expired" &&
            effectiveExpiry(row) !== null &&
            effectiveExpiry(row)! <= before,
        );
        const deleteIntent = connection.prepare(
          "DELETE FROM tab_session_intents WHERE id = ?",
        );
        let purged = 0;
        for (const row of due) {
          const inbound = selectInboundReplacement.all(
            row.idempotency_key,
          ) as SessionIntentRow[];
          if (
            row.archive_cause === "replacement" &&
            row.replacement_idempotency_key !== null
          ) {
            for (const source of inbound) {
              rewireReplacement.run(
                row.replacement_idempotency_key,
                source.id,
                row.idempotency_key,
              );
            }
          } else if (row.archive_cause === "explicit") {
            for (const source of inbound) {
              if (source.visibility === "share_with_ai") {
                reviveVisibleIntent.run(source.id);
              }
            }
          }
          purged += deleteIntent.run(row.id).changes;
        }
        return { purged };
      }),
    reconcilePhysicalScopes: createSessionIntentReconciler(connection)
      .reconcilePhysicalScopes,
  };
}
