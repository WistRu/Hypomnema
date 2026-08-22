import { createHash } from "node:crypto";

import {
  estimateResearchReservationV1,
  researchCanonicalSha256PayloadV1,
  researchSelectionFingerprintPayload,
  type ResearchApprovalRequest,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { classifyResourceUrlForResearch } from "../src/resource-catalog.js";
import {
  buildCurrentResearchDraft,
  buildCurrentResearchProjection,
  createResearchStore,
  fingerprintResearchApproval,
  fingerprintResearchCorpus,
} from "../src/research-store.js";

const at = "2026-08-13T16:00:00.000Z";
const budget = { maxSteps: 10, maxTokens: 1_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function seedPages(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (1, 'https://r.openai.com/1', 'https://r.openai.com/1', 'https://r.openai.com/1', '${at}', '${at}'),
      (2, 'https://r.openai.com/2', 'https://r.openai.com/2', 'https://r.openai.com/2', '${at}', '${at}'),
      (3, 'https://r.openai.com/3', 'https://r.openai.com/3', 'https://r.openai.com/3', '${at}', '${at}'),
      (4, 'https://outside.openai.com/4', 'https://outside.openai.com/4', 'https://outside.openai.com/4',
        '${at}', '${at}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES
      (11, 'https://r.openai.com/1', 'https://r.openai.com/1', 'One old', 'chrome', 'inbox', 0, 1,
        '${at}', '${at}', 1),
      (12, 'https://r.openai.com/1', 'https://r.openai.com/1', 'One current', 'firefox', 'inbox', 0, 1,
        '${at}', '${at}', 1),
      (21, 'https://r.openai.com/2', 'https://r.openai.com/2', 'Two', 'chrome', 'inbox', 0, 1,
        '${at}', '${at}', 2),
      (31, 'https://r.openai.com/3', 'https://r.openai.com/3', 'Three', 'chrome', 'inbox', 0, 1,
        '${at}', '${at}', 3),
      (41, 'https://outside.openai.com/4', 'https://outside.openai.com/4', 'Outside', 'chrome',
        'inbox', 0, 1, '${at}', '${at}', 4);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES
      (11, 'selected exact copy', '2026-08-13T15:00:00.000Z', 1),
      (12, 'higher revision wins', '2026-08-13T14:00:00.000Z', 2),
      (21, 'second page', '2026-08-13T15:30:00.000Z', 1),
      (41, 'outside page', '2026-08-13T15:45:00.000Z', 1);
    INSERT INTO resources (id, resource_key, created_at)
      VALUES (9, 'host:r.openai.com', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (90, 9, 1, 'R', 'website', 'authenticated', 'active',
      'system', 'derived', '${at}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES
      (91, 1, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'p1', '${at}'),
      (92, 2, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'p2', '${at}'),
      (93, 3, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'p3', '${at}');
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      VALUES (1, 91), (2, 92), (3, 93);
    INSERT INTO context_entries (
      id, logical_page_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES
      (101, 1, 'purpose', 'share page context', 'user', 'manual', 'share_with_ai',
        'active', 'append', 1, 'ctx-share', '${at}'),
      (102, 1, 'note', 'LOCAL SECRET', 'user', 'manual', 'local_only',
        'active', 'append', 2, 'ctx-local', '${at}'),
      (103, 2, 'note', 'accepted agent context', 'agent', 'on_behalf_of_user',
        'share_with_ai', 'active', 'append', 1, 'ctx-agent', '${at}');
    INSERT INTO context_entry_reviews (
      id, context_entry_id, verdict, reviewed_by, review_method, idempotency_key, created_at
    ) VALUES (104, 103, 'accepted', 'user', 'manual', 'ctx-agent-accept', '${at}');
    INSERT INTO resource_context_entries (
      id, resource_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES (201, 9, 'project', 'share resource context', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'resource-share', '${at}');
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (1, '2026-08-13', 1000, 500, '${at}');
    INSERT INTO relations (from_entity_id, to_entity_id, kind, note, created_by)
      SELECT first.id, second.id, 'related', 'same research', 'user'
      FROM knowledge_entities AS first, knowledge_entities AS second
      WHERE first.tab_id = 11 AND second.tab_id = 21;
  `);
}

function request(
  target: ResearchApprovalRequest["target"],
  captureIntent: ResearchApprovalRequest["captureIntent"] = {
    selectedTabIds: [], knownFailures: [],
  },
): ResearchApprovalRequest {
  const estimate = estimateResearchReservationV1({
    includedSources: 0, includedSourceBytes: 0, snapshotBytes: 0,
    questionBytes: 0, budget,
  });
  return {
    version: 1, target, question: "What matters?",
    scope: {
      acquisitionLevel: "captured_only", includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [hash("https://r.openai.com")],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null, approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "captured-only", version: 1 }, budget, estimate, captureIntent,
  };
}

describe("current research manifest builder", () => {
  it.each([
    ["chrome://settings", "format", "browser_internal"],
    ["chrome-extension://abc/page.html", "format", "extension"],
    ["file:///private.txt", "format", "file"],
    ["data:text/plain,secret", "format", "data"],
    ["ftp://openai.com/file", "format", "unsupported_scheme"],
    ["https://user:pass@openai.com/private", "privacy", "embedded_credentials"],
    ["http://localhost:7717", "privacy", "localhost"],
    ["http://127.0.0.1/private", "privacy", "private_ip"],
    ["https://printer.local/private", "privacy", "private_hostname"],
    ["https://openai.com/login", "privacy", "weak_sensitive_signal"],
  ] as const)("reuses Resource URL policy for %s", (url, category, reason) => {
    expect(classifyResourceUrlForResearch(url)).toEqual({
      kind: "excluded", category, reason,
    });
  });

  it("enumerates current DB state, preserves explicit order, and projects only accepted shareable data", () => {
    const database = openDatabase(":memory:");
    seedPages(database.connection);
    try {
      const target = { type: "selection" as const, logicalPageIds: [2, 1],
        fingerprint: hash(researchSelectionFingerprintPayload([2, 1])) };
      const draft = buildCurrentResearchDraft(database.connection, request(target, {
        selectedTabIds: [11], knownFailures: [],
      }), { clock: () => new Date(at) });
      expect(draft.sources.map((source) => ({ page: source.logicalPageId,
        tab: source.tabId, ordinal: source.ordinal, included: source.includedOrder })))
        .toEqual([
          { page: 2, tab: 21, ordinal: 1, included: 1 },
          { page: 1, tab: 11, ordinal: 2, included: 2 },
        ]);
      expect(draft.sources[1]?.payload?.evidenceMaterial).toBe("selected exact copy");
      expect(draft.snapshots?.map((snapshot) => snapshot.ordinal))
        .toEqual(draft.snapshots?.map((_, index) => index + 1));
      const projected = JSON.stringify(draft.snapshots);
      expect(projected).toContain("share page context");
      expect(projected).toContain("accepted agent context");
      expect(projected).toContain("share resource context");
      expect(projected).toContain("same research");
      expect(projected).not.toContain("LOCAL SECRET");
      expect(projected).not.toContain("local_only");
      const approvalBeforeLocalMutation = fingerprintResearchApproval(draft);
      const corpusBeforeLocalMutation = fingerprintResearchCorpus(draft);
      database.connection.prepare(`INSERT INTO context_entries (
        logical_page_id, kind, body, actor, method, visibility, state, operation,
        revision, idempotency_key, created_at
      ) VALUES (1, 'note', 'ANOTHER LOCAL SECRET', 'user', 'manual', 'local_only',
        'active', 'append', 3, 'ctx-local-2', ?)` ).run(at);
      const afterLocalMutation = buildCurrentResearchDraft(database.connection, request(target, {
        selectedTabIds: [11], knownFailures: [],
      }), { clock: () => new Date(at) });
      expect(fingerprintResearchApproval(afterLocalMutation)).toBe(approvalBeforeLocalMutation);
      expect(fingerprintResearchCorpus(afterLocalMutation)).toBe(corpusBeforeLocalMutation);
      const forwardIntent = buildCurrentResearchDraft(database.connection, request(target, {
        selectedTabIds: [21, 11], knownFailures: [],
      }), { clock: () => new Date(at) });
      const reverseIntent = buildCurrentResearchDraft(database.connection, request(target, {
        selectedTabIds: [11, 21], knownFailures: [],
      }), { clock: () => new Date(at) });
      expect(fingerprintResearchApproval(reverseIntent))
        .toBe(fingerprintResearchApproval(forwardIntent));
      expect(fingerprintResearchCorpus(reverseIntent))
        .toBe(fingerprintResearchCorpus(forwardIntent));
      expect(reverseIntent.sources.map((source) => source.logicalPageId)).toEqual([2, 1]);
    } finally {
      database.close();
    }
  });

  it("uses stable resource ordering, includes at most 100 sources, and rejects selected out-of-scope tabs", () => {
    const database = openDatabase(":memory:");
    seedPages(database.connection);
    try {
      const draft = buildCurrentResearchDraft(database.connection,
        request({ type: "resource", resourceId: 9 }), { clock: () => new Date(at) });
      expect(draft.sources.map((source) => source.logicalPageId)).toEqual([2, 1, 3]);
      expect(draft.sources.map((source) => source.inclusionState))
        .toEqual(["included", "included", "missing"]);
      const unconfirmed = request({ type: "resource", resourceId: 9 });
      const privacyClassified = buildCurrentResearchDraft(database.connection, {
        ...unconfirmed,
        scope: { ...unconfirmed.scope, privacyConfirmation: {
          ...unconfirmed.scope.privacyConfirmation, authenticatedOriginDigests: [],
        } },
      });
      expect(privacyClassified.sources.slice(0, 2).map((source) => ({
        eligibility: source.eligibility,
        reason: "exclusionReason" in source ? source.exclusionReason : null,
        payload: source.payload,
      }))).toEqual([
        { eligibility: "privacy_excluded", reason: "privacy", payload: null },
        { eligibility: "privacy_excluded", reason: "privacy", payload: null },
      ]);
      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (5, 'file:///one', 'file:///one', 'file:///one', '${at}', '${at}');
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, status, importance, is_open,
          first_seen_at, last_seen_at, logical_page_id
        ) VALUES (51, 'file:///one', 'file:///one', 'File', 'chrome', 'inbox', 0, 1,
          '${at}', '${at}', 5);
        INSERT INTO contents (tab_id, text, extracted_at, content_revision)
          VALUES (51, 'file evidence', '${at}', 1);
      `);
      const formatClassified = buildCurrentResearchDraft(database.connection,
        request({ type: "page", logicalPageId: 5 }));
      expect(formatClassified.sources[0]).toMatchObject({
        eligibility: "format_excluded", inclusionState: "excluded",
        exclusionReason: "format", payload: null,
      });
      const fourByteCodePoint = String.fromCodePoint(0x1f642);
      const oversized = fourByteCodePoint.repeat(16_385);
      const deterministicPrefix = fourByteCodePoint.repeat(16_384);
      database.connection.prepare(`
        UPDATE contents SET text = ?, content_revision = 3 WHERE tab_id = 12
      `).run(oversized);
      const truncated = buildCurrentResearchDraft(database.connection,
        request({ type: "page", logicalPageId: 1 }));
      expect(truncated.sources[0]).toMatchObject({
        eligibility: "eligible", inclusionState: "included",
        payload: {
          evidenceMaterial: deterministicPrefix,
          chunkManifest: {
            version: "captured_text_chunks:v1",
            byteStart: 0,
            byteEnd: 65_536,
            chunkDigest: hash(deterministicPrefix),
            truncated: true,
          },
        },
      });
      expect(truncated.sources[0]?.payload?.evidenceMaterial).not.toContain("�");
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(() => buildCurrentResearchDraft(database.connection,
        request({ type: "resource", resourceId: 9 }, {
          selectedTabIds: [41], knownFailures: [],
        }))).toThrow(/outside.*target|out.of.scope/i);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("fits quote-heavy shareable material by final canonical UTF-8 bytes and stores its digest", () => {
    const database = openDatabase(":memory:");
    seedPages(database.connection);
    try {
      const quoteHeavy = '"'.repeat(60_000);
      database.connection.prepare(`
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility, supersedes_id,
          state, operation, revision, idempotency_key, created_at
        ) VALUES (105, 1, 'purpose', ?, 'user', 'manual', 'share_with_ai', 101,
          'active', 'append', 3, 'ctx-quote-heavy', ?)
      `).run(quoteHeavy, at);
      database.connection.prepare(`
        INSERT INTO resource_context_entries (
          id, resource_id, kind, body, actor, method, visibility, supersedes_id,
          state, operation, revision, idempotency_key, created_at
        ) VALUES (202, 9, 'project', ?, 'user', 'manual', 'share_with_ai', 201,
          'active', 'append', 2, 'resource-quote-heavy', ?)
      `).run(quoteHeavy, at);
      database.connection.prepare(`UPDATE relations SET note = ?`).run(quoteHeavy);

      const base = request({ type: "page", logicalPageId: 1 });
      const initial = buildCurrentResearchDraft(database.connection, base,
        { clock: () => new Date(at) });
      const snapshots = initial.snapshots ?? [];
      for (const kind of ["page_context", "resource_context"] as const) {
        const snapshot = snapshots.find((candidate) => candidate.kind === kind)!;
        expect(snapshot.material).toMatchObject({ bodyTruncated: true });
        const canonical = new TextDecoder().decode(
          researchCanonicalSha256PayloadV1(snapshot.material),
        );
        expect(Buffer.byteLength(canonical, "utf8")).toBeLessThanOrEqual(65_536);
        expect(snapshot.snapshotDigest).toBe(hash(canonical));
      }
      const relation = snapshots.find((candidate) => candidate.kind === "relation")!;
      expect(relation.material).toMatchObject({ noteTruncated: true });
      const relationCanonical = new TextDecoder().decode(
        researchCanonicalSha256PayloadV1(relation.material),
      );
      expect(Buffer.byteLength(relationCanonical, "utf8")).toBeLessThanOrEqual(65_536);
      expect(relation.snapshotDigest).toBe(hash(relationCanonical));

      const approvalFingerprint = fingerprintResearchApproval(initial);
      const approval = { ...base, approvalFingerprint };
      const task: ResourceResearchTaskSpec = {
        version: 1, kind: "resource_research", subject: base.target,
        workflowRef: base.workflowRef, inputFingerprint: approvalFingerprint,
        idempotencyKey: "quote-heavy-snapshot-submit",
        provenance: { requestedBy: "user", requestMethod: "manual" },
        schedulingPriority: 0, budget,
      };
      const ledger = createAiJobLedger(database.connection, {
        kindAvailable: () => true,
        research: createResearchStore(database.connection, { clock: () => new Date(at) }),
      });
      expect(ledger.submitResearch(task, approval)).toMatchObject({ status: "queued" });
      const stored = database.connection.prepare(`
        SELECT payload.kind, payload.material_json, typed.snapshot_digest
        FROM research_snapshot_payloads AS payload
        JOIN (
          SELECT 'page_context' AS kind, id, snapshot_digest FROM research_page_context_snapshots
          UNION ALL SELECT 'resource_context', id, snapshot_digest
            FROM research_resource_context_snapshots
          UNION ALL SELECT 'activity', id, snapshot_digest FROM research_activity_snapshots
          UNION ALL SELECT 'relation', id, snapshot_digest FROM research_relation_snapshots
        ) AS typed ON typed.kind = payload.kind AND typed.id = payload.snapshot_id
      `).all() as Array<{ kind: string; material_json: string; snapshot_digest: string }>;
      expect(stored).toHaveLength(snapshots.length);
      for (const row of stored) {
        expect(Buffer.byteLength(row.material_json, "utf8")).toBeLessThanOrEqual(65_536);
        expect(row.snapshot_digest).toBe(hash(row.material_json));
      }
    } finally {
      database.close();
    }
  });

  it("rebuilds before submit and returns stale with zero writes after source mutation", () => {
    const database = openDatabase(":memory:");
    seedPages(database.connection);
    try {
      const initial = request({ type: "page", logicalPageId: 1 });
      const built = buildCurrentResearchDraft(database.connection, initial,
        { clock: () => new Date(at) });
      const approval = { ...initial, approvalFingerprint: fingerprintResearchApproval(built) };
      database.connection.prepare(`
        UPDATE contents SET text = 'mutated', content_revision = 3 WHERE tab_id = 12
      `).run();
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      const task: ResourceResearchTaskSpec = {
        version: 1, kind: "resource_research",
        subject: { type: "page", logicalPageId: 1 }, workflowRef: approval.workflowRef,
        inputFingerprint: approval.approvalFingerprint, idempotencyKey: "stale-current-builder",
        provenance: { requestedBy: "user", requestMethod: "manual" },
        schedulingPriority: 0, budget,
      };
      expect(() => createResearchStore(database.connection, {
        clock: () => new Date(at),
      }).prepareSubmission(task, approval)).toThrowError(expect.objectContaining({
        code: "RESEARCH_PREFLIGHT_STALE",
      }));
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("keeps a 101-page resource manifest complete while including only its stable first 100", () => {
    const database = openDatabase(":memory:");
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at) VALUES (9, 'host:cap.openai.com', '${at}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (90, 9, 1, 'Cap', 'website', 'public', 'active',
          'system', 'derived', '${at}');
        INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
      `);
      const insertPage = database.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      const insertTab = database.connection.prepare(`INSERT INTO tabs (
        id, url, url_normalized, title, browser, status, importance, is_open,
        first_seen_at, last_seen_at, logical_page_id
      ) VALUES (?, ?, ?, ?, 'chrome', 'inbox', 0, 1, ?, ?, ?)`);
      const insertContent = database.connection.prepare(`
        INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES (?, ?, ?, 1)
      `);
      const insertAssignment = database.connection.prepare(`
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (?, ?, 'assigned', 9, 'registrable_domain', 'system', 'derived', ?, ?)
      `);
      const insertHead = database.connection.prepare(`
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id) VALUES (?, ?)
      `);
      database.connection.transaction(() => {
        for (let id = 1; id <= 101; id += 1) {
          const url = `https://cap.openai.com/${id}`;
          insertPage.run(id, url, url, url, at, at);
          insertTab.run(id, url, url, `Page ${id}`, at, at, id);
          insertContent.run(id, `evidence ${id}`, at);
          insertAssignment.run(id, id, `cap-${id}`, at);
          insertHead.run(id, id);
        }
      })();
      const draft = buildCurrentResearchDraft(database.connection,
        request({ type: "resource", resourceId: 9 }));
      expect(draft.sources).toHaveLength(101);
      expect(draft.sources.filter((source) => source.inclusionState === "included"))
        .toHaveLength(100);
      expect(draft.sources[99]).toMatchObject({
        logicalPageId: 100, ordinal: 100, includedOrder: 100, inclusionState: "included",
      });
      expect(draft.sources[100]).toMatchObject({
        logicalPageId: 101, ordinal: 101, includedOrder: null,
        inclusionState: "excluded", exclusionReason: "source_limit",
      });
    } finally {
      database.close();
    }
  });

  it("keeps the 4 MiB corpus as a deterministic prefix after the first overflow", () => {
    const database = openDatabase(":memory:");
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
          VALUES (9, 'host:byte-cap.openai.com', '${at}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (90, 9, 1, 'Byte cap', 'website', 'public', 'active',
          'system', 'derived', '${at}');
        INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
      `);
      const insertPage = database.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      const insertTab = database.connection.prepare(`INSERT INTO tabs (
        id, url, url_normalized, title, browser, status, importance, is_open,
        first_seen_at, last_seen_at, logical_page_id
      ) VALUES (?, ?, ?, ?, 'chrome', 'inbox', 0, 1, ?, ?, ?)`);
      const insertContent = database.connection.prepare(`
        INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES (?, ?, ?, 1)
      `);
      const insertAssignment = database.connection.prepare(`
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (?, ?, 'assigned', 9, 'registrable_domain', 'system', 'derived', ?, ?)
      `);
      const insertHead = database.connection.prepare(`
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id) VALUES (?, ?)
      `);
      database.connection.transaction(() => {
        for (let id = 1; id <= 66; id += 1) {
          const url = `https://byte-cap.openai.com/${id}`;
          const tabId = 1_000 + id;
          const assignmentId = 2_000 + id;
          const bytes = id <= 63 ? 65_536 : id === 64 ? 64_536 : id === 65 ? 2_000 : 500;
          insertPage.run(id, url, url, url, at, at);
          insertTab.run(tabId, url, url, `Page ${id}`, at, at, id);
          insertContent.run(tabId, "x".repeat(bytes), at);
          insertAssignment.run(assignmentId, id, `byte-cap-${id}`, at);
          insertHead.run(id, assignmentId);
        }
      })();

      const projection = buildCurrentResearchProjection(
        database.connection,
        request({ type: "resource", resourceId: 9 }),
        { clock: () => new Date(at) },
      );
      const included = projection.draft.sources.filter(
        (source) => source.inclusionState === "included",
      );
      const includedBytes = included.reduce((total, source) =>
        total + Buffer.byteLength(source.payload?.evidenceMaterial ?? "", "utf8"), 0);
      expect(included).toHaveLength(64);
      expect(included.map((source) => source.includedOrder))
        .toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
      expect(includedBytes).toBe(4 * 1024 * 1024 - 1_000);
      expect(includedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(projection.draft.sources.slice(64)).toMatchObject([
        { ordinal: 65, eligibility: "eligible", inclusionState: "excluded",
          exclusionReason: "source_limit", includedOrder: null },
        { ordinal: 66, eligibility: "eligible", inclusionState: "excluded",
          exclusionReason: "source_limit", includedOrder: null },
      ]);
      expect(projection.sources.slice(64)).toMatchObject([
        { ordinal: 65, exclusionReason: "corpus_byte_limit", exclusionCategory: "limit" },
        { ordinal: 66, exclusionReason: "corpus_byte_limit", exclusionCategory: "limit" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects a resource scope above 10,000 without truncation or writes", () => {
    const database = openDatabase(":memory:");
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at) VALUES (9, 'host:q.openai.com', '${at}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (90, 9, 1, 'Q', 'website', 'public', 'active',
          'system', 'derived', '${at}');
        INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
      `);
      const insertPage = database.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      const insertAssignment = database.connection.prepare(`
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (?, ?, 'assigned', 9, 'registrable_domain', 'system', 'derived', ?, ?)
      `);
      const insertHead = database.connection.prepare(`
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id) VALUES (?, ?)
      `);
      database.connection.transaction(() => {
        for (let id = 1; id <= 10_001; id += 1) {
          const url = `https://q.openai.com/${id}`;
          insertPage.run(id, url, url, url, at, at);
          insertAssignment.run(id, id, `q-${id}`, at);
          insertHead.run(id, id);
        }
      })();
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(() => buildCurrentResearchDraft(database.connection,
        request({ type: "resource", resourceId: 9 }))).toThrowError(
        expect.objectContaining({ code: "RESEARCH_SCOPE_TOO_LARGE" }),
      );
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  }, 30_000);

  it("submits an empty captured body as a typed size exclusion", () => {
    const database = openDatabase(":memory:");
    seedPages(database.connection);
    try {
      database.connection.prepare(`
        UPDATE contents SET text = '', content_revision = 3 WHERE tab_id = 12
      `).run();
      const base = request({ type: "page", logicalPageId: 1 });
      const initial = buildCurrentResearchDraft(database.connection, base);
      const approval = { ...base, approvalFingerprint: fingerprintResearchApproval(initial) };
      const task: ResourceResearchTaskSpec = {
        version: 1, kind: "resource_research", subject: base.target,
        workflowRef: base.workflowRef, inputFingerprint: approval.approvalFingerprint,
        idempotencyKey: "empty-capture-submit", provenance: {
          requestedBy: "user", requestMethod: "manual",
        }, schedulingPriority: 0, budget,
      };
      const research = createResearchStore(database.connection);
      const ledger = createAiJobLedger(database.connection, {
        kindAvailable: () => true, research,
      });
      expect(ledger.submitResearch(task, approval)).toMatchObject({
        kind: "resource_research", status: "queued",
      });
      expect(database.connection.prepare(`
        SELECT eligibility, inclusion_state, exclusion_reason
        FROM research_sources WHERE run_id = 1
      `).get()).toEqual({
        eligibility: "size_excluded", inclusion_state: "excluded", exclusion_reason: "size",
      });
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_source_payloads`)
        .pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
