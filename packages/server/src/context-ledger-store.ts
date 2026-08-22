import type Database from "better-sqlite3";

import {
  contextBundleSchema,
  contextEntryReviewSchema,
  contextEntrySchema,
  modelProvenanceSchema,
  shareableContextBundleSchema,
  shareableContextEntrySchema,
  type ContextBundle,
  type ContextChangeResult,
  type ContextCommand,
  type ContextEntry,
  type ContextEntryReview,
  type ContextProvenance,
  type ContextSubject,
  type ModelProvenance,
  type ShareableContextBundle,
  type ShareableContextEntry,
} from "@tabhub/shared";

import { ContextLedgerError, type ContextLedgerErrorCode } from "./context-ledger-errors.js";

export interface ContextStoreHooks {
  afterEntryInsert?: (operation: "append" | "withdraw" | "restore") => void;
  afterReviewInsert?: () => void;
}

export interface ContextStoreDescriptor {
  type: ContextSubject["type"];
  idColumn: "logical_page_id" | "resource_id";
  identityTable: "logical_pages" | "resources";
  entryTable: "context_entries" | "resource_context_entries";
  reviewTable: "context_entry_reviews" | "resource_context_entry_reviews";
  ftsTable: "context_entries_fts" | "resource_context_entries_fts";
  shareableFtsTable:
    | "shareable_context_entries_fts"
    | "shareable_resource_context_entries_fts";
  notFoundCode: Extract<ContextLedgerErrorCode, "LOGICAL_PAGE_NOT_FOUND" | "RESOURCE_NOT_FOUND">;
  isWritable?: (subjectId: number) => boolean;
}

interface EntryRow {
  id: number; subject_id: number; kind: ContextEntry["entryKind"]; body: string;
  actor: "user" | "agent" | "system";
  method: "manual" | "on_behalf_of_user" | "rule" | "model" | "derived";
  visibility: ContextEntry["visibility"]; confidence: number | null;
  source_fingerprint: string | null; model_provenance_json: string | null;
  stale_at: string | null; supersedes_id: number | null;
  state: ContextEntry["state"]; operation: ContextEntry["operation"];
  revision: number; idempotency_key: string; created_at: string;
  withdrawn_at: string | null;
}

interface ReviewRow {
  id: number; context_entry_id: number; verdict: ContextEntryReview["verdict"];
  reviewed_by: "user" | "agent"; review_method: "manual" | "on_behalf_of_user";
  idempotency_key: string; supersedes_id: number | null; created_at: string;
}

export interface ContextStore {
  readLocal(subject: ContextSubject): ContextBundle;
  readShareable(subject: ContextSubject): ShareableContextBundle;
  change(command: ContextCommand): ContextChangeResult;
  search(input: { subjectId?: number; limit?: number; query: string }, shareable: boolean):
    ContextEntry[] | ShareableContextEntry[];
}

const entryTables = ["context_entries", "resource_context_entries"] as const;
const reviewTables = ["context_entry_reviews", "resource_context_entry_reviews"] as const;

function safeFtsQuery(query: string): string {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, 64).map((token) => Array.from(token).slice(0, 256).join(""));
  return tokens.length === 0 ? '"__tabhub_no_context_search_tokens__"'
    : tokens.map((token) => `"${token}"*`).join(" AND ");
}

function provenanceParts(provenance: ContextProvenance) {
  return {
    confidence: "confidence" in provenance ? (provenance.confidence ?? null) : null,
    sourceFingerprint: "sourceFingerprint" in provenance
      ? (provenance.sourceFingerprint ?? null) : null,
    modelProvenanceJson:
      provenance.actor === "agent" && provenance.method === "model"
        ? JSON.stringify(provenance.model) : null,
  };
}

function provenanceFrom(row: EntryRow): ContextProvenance {
  const confidence = row.confidence === null ? {} : { confidence: row.confidence };
  if (row.actor === "user" && row.method === "manual") return { actor: "user", method: "manual" };
  if (row.actor === "agent" && row.method === "on_behalf_of_user") return { actor: "agent", method: "on_behalf_of_user" };
  if (row.actor === "agent" && row.method === "rule" && row.source_fingerprint !== null) {
    return { actor: "agent", method: "rule", sourceFingerprint: row.source_fingerprint, ...confidence };
  }
  if (row.actor === "agent" && row.method === "model" && row.source_fingerprint !== null && row.model_provenance_json !== null) {
    let model: ModelProvenance;
    try { model = modelProvenanceSchema.parse(JSON.parse(row.model_provenance_json)); }
    catch { throw new Error("Stored context provenance violates schema invariants"); }
    return { actor: "agent", method: "model", sourceFingerprint: row.source_fingerprint, model, ...confidence };
  }
  if (row.actor === "system" && row.method === "derived" && row.source_fingerprint !== null) {
    return { actor: "system", method: "derived", sourceFingerprint: row.source_fingerprint, ...confidence };
  }
  throw new Error("Stored context provenance violates schema invariants");
}

function idFor(subject: ContextSubject): number {
  return subject.type === "page" ? subject.logicalPageId : subject.resourceId;
}

export function createContextStore(
  connection: Database.Database,
  descriptor: ContextStoreDescriptor,
  now: () => string,
  hooks: ContextStoreHooks = {},
): ContextStore {
  const selectColumns = `entries.*, entries.${descriptor.idColumn} AS subject_id`;
  const exists = connection.prepare(`SELECT 1 FROM ${descriptor.identityTable} WHERE id = ?`);
  const selectEntry = connection.prepare(`SELECT ${selectColumns} FROM ${descriptor.entryTable} AS entries WHERE entries.id = ?`);
  const selectEntryByKey = connection.prepare(`SELECT ${selectColumns} FROM ${descriptor.entryTable} AS entries WHERE entries.idempotency_key = ?`);
  const selectEntries = connection.prepare(`SELECT ${selectColumns} FROM ${descriptor.entryTable} AS entries WHERE entries.${descriptor.idColumn} = ? ORDER BY entries.revision DESC, entries.id DESC`);
  const selectRevision = connection.prepare(`SELECT COALESCE(MAX(revision),0)+1 FROM ${descriptor.entryTable} WHERE ${descriptor.idColumn} = ?`);
  const selectSuperseding = connection.prepare(`SELECT id FROM ${descriptor.entryTable} WHERE supersedes_id = ?`);
  const selectReviewByKey = connection.prepare(`SELECT * FROM ${descriptor.reviewTable} WHERE idempotency_key = ?`);
  const selectCurrentReview = connection.prepare(`SELECT reviews.* FROM ${descriptor.reviewTable} AS reviews
    WHERE reviews.context_entry_id = ? AND NOT EXISTS (
      SELECT 1 FROM ${descriptor.reviewTable} AS newer WHERE newer.supersedes_id = reviews.id)
    ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1`);
  const insertEntry = connection.prepare(`INSERT INTO ${descriptor.entryTable} (
    ${descriptor.idColumn}, kind, body, actor, method, visibility, confidence,
    source_fingerprint, model_provenance_json, stale_at, supersedes_id,
    state, operation, revision, idempotency_key, created_at, withdrawn_at
  ) VALUES (@subjectId,@entryKind,@body,@actor,@method,@visibility,@confidence,
    @sourceFingerprint,@modelProvenanceJson,@staleAt,@supersedesId,@state,
    @operation,@revision,@idempotencyKey,@createdAt,@withdrawnAt)`);
  const insertReview = connection.prepare(`INSERT INTO ${descriptor.reviewTable} (
    context_entry_id, verdict, reviewed_by, review_method, idempotency_key,
    supersedes_id, created_at
  ) VALUES (@contextEntryId,@verdict,@reviewedBy,@reviewMethod,@idempotencyKey,
    @supersedesId,@createdAt)`);
  const anyEntryKey = connection.prepare(entryTables.map((table) =>
    `SELECT 1 FROM ${table} WHERE idempotency_key = ?`).join(" UNION ALL ") + " LIMIT 1");
  const anyReviewKey = connection.prepare(reviewTables.map((table) =>
    `SELECT 1 FROM ${table} WHERE idempotency_key = ?`).join(" UNION ALL ") + " LIMIT 1");

  const atomically = <T>(operation: () => T): T =>
    connection.inTransaction ? operation() : connection.transaction(operation)();
  const requireSubject = (subject: ContextSubject) => {
    if (subject.type !== descriptor.type) throw new ContextLedgerError("CONTEXT_SUBJECT_MISMATCH");
    if (exists.get(idFor(subject)) === undefined) throw new ContextLedgerError(descriptor.notFoundCode);
  };
  const requireWritable = (subjectId: number) => {
    if (descriptor.isWritable?.(subjectId) === false) {
      throw new ContextLedgerError("RESOURCE_NOT_ACTIVE");
    }
  };
  const requireEntry = (entryId: number): EntryRow => {
    const row = selectEntry.get(entryId) as EntryRow | undefined;
    if (row === undefined) throw new ContextLedgerError("CONTEXT_ENTRY_NOT_FOUND");
    return row;
  };
  const reviewFrom = (row: ReviewRow): ContextEntryReview => contextEntryReviewSchema.parse({
    id: row.id, contextEntryId: row.context_entry_id, verdict: row.verdict,
    provenance: row.reviewed_by === "user"
      ? { actor: "user", method: "manual" }
      : { actor: "agent", method: "on_behalf_of_user" },
    idempotencyKey: row.idempotency_key, supersedesId: row.supersedes_id,
    createdAt: row.created_at,
  });
  const currentReviewFor = (entryId: number): ContextEntryReview | null => {
    const row = selectCurrentReview.get(entryId) as ReviewRow | undefined;
    return row === undefined ? null : reviewFrom(row);
  };
  const subjectFor = (subjectId: number): ContextSubject => descriptor.type === "page"
    ? { type: "page", logicalPageId: subjectId }
    : { type: "resource", resourceId: subjectId };
  const entryFrom = (row: EntryRow, review: ContextEntryReview | null = currentReviewFor(row.id)): ContextEntry =>
    contextEntrySchema.parse({
      id: row.id, subject: subjectFor(row.subject_id), entryKind: row.kind,
      body: row.body, provenance: provenanceFrom(row), visibility: row.visibility,
      staleAt: row.stale_at, supersedesId: row.supersedes_id, state: row.state,
      operation: row.operation, revision: row.revision,
      idempotencyKey: row.idempotency_key, createdAt: row.created_at,
      withdrawnAt: row.withdrawn_at, currentReview: review,
    });
  const shareableFrom = (row: EntryRow): ShareableContextEntry => shareableContextEntrySchema.parse({
    entryKind: row.kind, body: row.body, provenance: provenanceFrom(row),
    visibility: "share_with_ai", staleAt: row.stale_at, state: row.state,
    createdAt: row.created_at, reviewVerdict: currentReviewFor(row.id)?.verdict ?? null,
  });
  const requireCurrent = (subject: ContextSubject, entryId: number, state?: ContextEntry["state"]) => {
    const row = requireEntry(entryId);
    if (row.subject_id !== idFor(subject)) throw new ContextLedgerError("CONTEXT_SUBJECT_MISMATCH");
    if (selectSuperseding.get(entryId) !== undefined) throw new ContextLedgerError("CONTEXT_ENTRY_NOT_CURRENT");
    if (state !== undefined && row.state !== state) throw new ContextLedgerError("CONTEXT_STATE_INVALID");
    return row;
  };
  const sameProvenance = (row: EntryRow, provenance: ContextProvenance) => {
    const parts = provenanceParts(provenance);
    return row.actor === provenance.actor && row.method === provenance.method &&
      row.confidence === parts.confidence && row.source_fingerprint === parts.sourceFingerprint &&
      row.model_provenance_json === parts.modelProvenanceJson;
  };

  const bundle = (subject: ContextSubject, shareable: boolean): ContextBundle | ShareableContextBundle => {
    requireSubject(subject);
    const rows = (selectEntries.all(idFor(subject)) as EntryRow[])
      .filter((row) => !shareable || row.visibility === "share_with_ai");
    const visible = new Set(rows.map((row) => row.id));
    const superseded = new Set(rows.map((row) => row.supersedes_id)
      .filter((id): id is number => id !== null && (!shareable || visible.has(id))));
    if (shareable) {
      const entries = rows.map(shareableFrom);
      const currentEntries = rows.filter((row) => !superseded.has(row.id)).map(shareableFrom);
      const active = currentEntries.filter((entry) => entry.state === "active");
      let preview: ShareableContextBundle["preview"] = null;
      for (const actor of ["user", "agent"] as const) for (const entryKind of ["next_action", "purpose", "note"] as const) {
        const entry = active.find((item) => item.entryKind === entryKind && item.provenance.actor === actor &&
          (actor === "user" || item.reviewVerdict === "accepted"));
        if (entry !== undefined && preview === null) preview = { entryKind, body: entry.body, actor };
      }
      return shareableContextBundleSchema.parse({ subject, entries, currentEntries, preview });
    }
    const entries = rows.map((row) => entryFrom(row));
    const currentEntries = entries.filter((entry) => !superseded.has(entry.id));
    const active = currentEntries.filter((entry) => entry.state === "active");
    let preview: ContextBundle["preview"] = null;
    for (const actor of ["user", "agent"] as const) for (const entryKind of ["next_action", "purpose", "note"] as const) {
      const entry = active.find((item) => item.entryKind === entryKind && item.provenance.actor === actor &&
        (actor === "user" || item.currentReview?.verdict === "accepted"));
      if (entry !== undefined && preview === null) preview = { entryId: entry.id, entryKind, body: entry.body, actor };
    }
    return contextBundleSchema.parse({ subject, entries, currentEntries, preview });
  };

  const change = (command: ContextCommand): ContextChangeResult => atomically(() => {
    const subjectId = idFor(command.subject);
    if (command.kind === "review") {
      if (anyEntryKey.get(command.idempotencyKey, command.idempotencyKey) !== undefined) {
        throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
      }
      const replay = selectReviewByKey.get(command.idempotencyKey) as ReviewRow | undefined;
      if (replay !== undefined) {
        const replayedEntry = requireEntry(replay.context_entry_id);
        if (replay.context_entry_id !== command.entryId || replay.verdict !== command.verdict ||
          replay.reviewed_by !== command.provenance.actor ||
          replay.review_method !== command.provenance.method ||
          replayedEntry.subject_id !== subjectId) {
          throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
        }
        return { kind: "reviewed", review: reviewFrom(replay) };
      }
      if (anyReviewKey.get(command.idempotencyKey, command.idempotencyKey) !== undefined) {
        throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
      }
      requireSubject(command.subject);
      requireWritable(subjectId);
      const entry = requireEntry(command.entryId);
      if (entry.subject_id !== subjectId) throw new ContextLedgerError("CONTEXT_SUBJECT_MISMATCH");
      if (entry.actor !== "agent") throw new ContextLedgerError("CONTEXT_REVIEW_NOT_ALLOWED");
      const current = selectCurrentReview.get(entry.id) as ReviewRow | undefined;
      const result = insertReview.run({ contextEntryId: entry.id, verdict: command.verdict,
        reviewedBy: command.provenance.actor, reviewMethod: command.provenance.method,
        idempotencyKey: command.idempotencyKey, supersedesId: current?.id ?? null, createdAt: now() });
      hooks.afterReviewInsert?.();
      const inserted = connection.prepare(`SELECT * FROM ${descriptor.reviewTable} WHERE id = ?`)
        .get(Number(result.lastInsertRowid)) as ReviewRow;
      return { kind: "reviewed", review: reviewFrom(inserted) };
    }

    if (anyReviewKey.get(command.idempotencyKey, command.idempotencyKey) !== undefined) {
      throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
    }
    const replay = selectEntryByKey.get(command.idempotencyKey) as EntryRow | undefined;
    if (replay !== undefined) {
      const same = replay.subject_id === subjectId && replay.operation === command.kind &&
        (command.kind === "append" ? replay.kind === command.entryKind && replay.body === command.body &&
          replay.visibility === command.visibility && replay.stale_at === (command.staleAt ?? null) &&
          replay.supersedes_id === (command.supersedesEntryId ?? null) && sameProvenance(replay, command.provenance)
          : replay.supersedes_id === command.entryId && sameProvenance(replay, command.provenance));
      if (!same) throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
      return { kind: "changed", operation: replay.operation, entry: entryFrom(replay, null) };
    }
    if (anyEntryKey.get(command.idempotencyKey, command.idempotencyKey) !== undefined) {
      throw new ContextLedgerError("IDEMPOTENCY_KEY_CONFLICT");
    }
    requireSubject(command.subject);
    requireWritable(subjectId);
    let entryKind: ContextEntry["entryKind"], body: string, visibility: ContextEntry["visibility"];
    let staleAt: string | null, supersedesId: number | null, state: ContextEntry["state"];
    let withdrawnAt: string | null;
    if (command.kind === "append") {
      const target = command.supersedesEntryId === undefined ? undefined
        : requireCurrent(command.subject, command.supersedesEntryId, "active");
      entryKind = command.entryKind; body = command.body; visibility = command.visibility;
      staleAt = command.staleAt ?? null; supersedesId = target?.id ?? null;
      state = "active"; withdrawnAt = null;
    } else {
      const target = requireCurrent(command.subject, command.entryId,
        command.kind === "withdraw" ? "active" : "withdrawn");
      entryKind = target.kind; body = target.body; visibility = target.visibility;
      staleAt = target.stale_at; supersedesId = target.id;
      state = command.kind === "withdraw" ? "withdrawn" : "active";
      withdrawnAt = command.kind === "withdraw" ? now() : null;
    }
    const createdAt = now();
    const result = insertEntry.run({ subjectId, entryKind, body,
      actor: command.provenance.actor, method: command.provenance.method,
      visibility, ...provenanceParts(command.provenance), staleAt, supersedesId,
      state, operation: command.kind, revision: Number(selectRevision.pluck().get(subjectId)),
      idempotencyKey: command.idempotencyKey, createdAt, withdrawnAt });
    hooks.afterEntryInsert?.(command.kind);
    const entry = requireEntry(Number(result.lastInsertRowid));
    return { kind: "changed", operation: entry.operation, entry: entryFrom(entry, null) };
  });

  const search = (input: { subjectId?: number; limit?: number; query: string }, shareable: boolean) => {
    try {
      const fts = shareable ? descriptor.shareableFtsTable : descriptor.ftsTable;
      const predicates = [`${fts} MATCH @query`];
      if (input.subjectId !== undefined) predicates.push(`entries.${descriptor.idColumn} = @subjectId`);
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM ${descriptor.entryTable} AS newer
        WHERE newer.supersedes_id = entries.id
          ${shareable ? "AND newer.visibility = 'share_with_ai'" : ""}
      )`);
      const rows = connection.prepare(`SELECT ${selectColumns} FROM ${fts}
        JOIN ${descriptor.entryTable} AS entries ON entries.id = ${fts}.rowid
        WHERE ${predicates.join(" AND ")}
        ORDER BY bm25(${fts}), entries.revision DESC, entries.id DESC LIMIT @limit`).all({
          query: safeFtsQuery(input.query), subjectId: input.subjectId ?? null,
          limit: input.limit ?? 100,
        }) as EntryRow[];
      return shareable ? rows.map(shareableFrom) : rows.map((row) => entryFrom(row));
    } catch {
      throw new Error("Context search failed");
    }
  };

  return {
    readLocal: (subject) => bundle(subject, false) as ContextBundle,
    readShareable: (subject) => bundle(subject, true) as ShareableContextBundle,
    change,
    search,
  };
}
