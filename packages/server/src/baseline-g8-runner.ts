import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";

import { canonicalJsonV1 as canonicalJson } from "@tabhub/shared";
import type {
  ResearchPreflight,
  ResearchPreflightRequest,
} from "@tabhub/shared";

import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const fixedClock = "2026-01-03T00:00:00.000Z";
const fixtureClock = "2026-01-02T00:00:00.000Z";
const localBootstrapSecret = "q10k-g8-local-bootstrap-only";
const maximumSourceBytes = 65_536;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contractHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export const q10kG8V1 = deepFreeze({
  version: 1,
  querySet: "Q10K-G8-v1",
  fixture: {
    acceptedSource: "S10K-v1",
    acceptedSourcePath:
      "D:\\VibeCoding\\TabHub\\.tmp\\personal-attention-layer\\g0-baseline-20260812T122100\\S10K-v1.sqlite",
    acceptedSourceSha256:
      "d5cb2f53d3ba7bca7cf764b17ad7893536df5ffe29e131a65765848a5d71eefe",
    derivedFixture: "S10K-G8-v1",
  expectedSchemaVersion: 24,
    fixedClock,
    fixtureClock,
    targetSizes: [1, 100, 10_000],
    resourceAlgorithm: "disjoint-resource-scopes-1-100-10000-v1",
    mixedCorpusAlgorithm:
      "first-100-public-captured-next-100-browser-internal-next-9700-public-captured-final-100-missing-v1",
    maximumScopeCoverage: {
      captured: 9_900,
      discovered: 10_000,
      eligible: 9_800,
      failed: 0,
      included: 100,
      missing: 100,
    },
    availableShareableSnapshots: 120,
    snapshotCap: 100,
    sourceCap: 100,
    corpusByteCap: 4 * 1024 * 1024,
    perSourceByteCap: maximumSourceBytes,
  },
  featureProfile: {
    activityDailyWriter: false,
    activityWindows: false,
    context: true,
    logicalImportance: true,
    pageSummaryCapture: false,
    resources: true,
    priorityAssessmentWriter: false,
    priorityPersonalization: false,
    priorityReaders: false,
    priorityShadow: false,
    research: true,
  },
  authProfile: {
    kind: "local_web_session",
    bootstrapOutsideMeasurement: true,
    sameSiteHeader: "same-origin",
  },
  request: {
    version: 1,
    question: "Assess the value of this Resource corpus.",
    includeShareableContext: true,
    maxIncludedSources: 100,
    parentReportId: null,
    budget: {
      maxSteps: 100,
      maxTokens: 200_000,
      maxCostUsd: 2,
      maxWallTimeMs: 1_800_000,
    },
    captureIntent: { selectedTabIds: [], knownFailures: [] },
    confirmedOrigins: {
      authenticatedOriginDigests: [],
      sensitiveOriginDigests: [],
    },
  },
  oracle: {
    kind: "independent_raw_sql_and_canonical_sha256_v1",
    productionFingerprintImportsAllowed: false,
    exactResponse: true,
  },
  warmups: 3,
  samples: 20,
  statementExecutionLimit: 30,
  p95LimitMs: 2_000,
} as const);

export const q10kG8V1Hash = contractHash(q10kG8V1);

interface G8DatabaseIdentity {
  readonly databaseBytes: number;
  readonly fileSha256: string;
  readonly foreignKeyViolationCount: number;
  readonly integrityCheck: readonly string[];
  readonly schemaSha256: string;
  readonly schemaVersion: number;
}

interface G8FixtureIdentity {
  readonly acceptedSource: string;
  readonly acceptedSourceSha256: string;
  readonly derivedFixture: string;
  readonly expectedSchemaVersion: number;
}

interface G8RunIdentity {
  readonly artifactName: "Q10K-G8-candidate.json" | "Q10K-G8-v1.json";
  readonly contractHash: string;
  readonly expectedSourcePath: string | null;
  readonly expectedSourceSha256: string;
  readonly fixture: G8FixtureIdentity;
  readonly official: boolean;
  readonly querySet: string;
  readonly samples: number;
  readonly warmups: number;
}

export interface G8ScopeTiming {
  readonly coverage: ResearchPreflight["coverage"];
  readonly includedSourceCount: number;
  readonly manifestSize: number;
  readonly maximumPreparedStatementExecutions: number;
  readonly maximumTotalChangesDelta: number;
  readonly maximumUniquePreparedStatements: number;
  readonly maximumWriteStatementExecutions: number;
  readonly oracleFingerprint: string;
  readonly oracleMatches: number;
  readonly p50Ms: number;
  readonly p95LimitMs: number;
  readonly p95Ms: number;
  readonly passed: boolean;
  readonly resourceId: number;
  readonly samples: number;
  readonly snapshotCount: number;
  readonly timingsMs: readonly number[];
  readonly warmups: number;
}

export interface G8BaselineResult {
  readonly contractHash: string;
  readonly correctnessPassed: boolean;
  readonly databaseDeterminism: Readonly<{
    exactBytes: boolean;
    primary: G8DatabaseIdentity;
    replica: G8DatabaseIdentity;
  }>;
  readonly fixture: G8FixtureIdentity;
  readonly hashes: Readonly<{
    contractSha256: string;
    primaryDerivedSha256: string;
    replicaDerivedSha256: string;
    runnerSourceSha256: string;
    sourceSha256: string;
  }>;
  readonly measurement: Readonly<{
    after: G8DatabaseIdentity;
    before: G8DatabaseIdentity;
    bytesUnchanged: boolean;
    totalChangesDelta: number;
  }>;
  readonly official: boolean;
  readonly passed: boolean;
  readonly performancePassed: boolean;
  readonly querySet: string;
  readonly runtime: Readonly<{
    command: readonly string[];
    head: string;
    node: string;
    platform: NodeJS.Platform;
  }>;
  readonly scopes: readonly G8ScopeTiming[];
  readonly source: Readonly<{
    afterSha256: string;
    beforeMtimeMs: number;
    beforeSha256: string;
    bytes: number;
    path: string;
    unchanged: boolean;
  }>;
}

export interface G8BaselineEvidence {
  readonly artifactSha256: string;
  readonly contractSha256: string;
  readonly primaryDerivedSha256: string;
  readonly replicaDerivedSha256: string;
  readonly runnerSourceSha256: string;
  readonly sourceSha256: string;
}

export interface G8BaselineRun {
  readonly artifactPath: string;
  readonly evidence: G8BaselineEvidence;
  readonly evidencePath: string;
  readonly result: G8BaselineResult;
}

export interface RunG8BaselineOptions {
  readonly sourcePath: string;
  readonly workDirectory: string;
}

interface FixtureScope {
  readonly resourceId: number;
  readonly size: number;
}

interface DerivedFixture {
  readonly database: G8DatabaseIdentity;
  readonly scopes: readonly FixtureScope[];
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function checkpoint(connection: Database.Database): void {
  connection.pragma("wal_checkpoint(TRUNCATE)");
}

async function checkpointPath(path: string): Promise<void> {
  const database = new Database(path, { fileMustExist: true });
  try {
    checkpoint(database);
  } finally {
    database.close();
  }
}

async function removeEmptyCheckpointSidecars(path: string): Promise<void> {
  const walPath = `${path}-wal`;
  try {
    const wal = await stat(walPath);
    if (wal.size !== 0) {
      throw new Error(`Q10K-G8 checkpoint left a non-empty WAL: ${wal.size} bytes`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(walPath, { force: true });
  await rm(`${path}-shm`, { force: true });
}

async function inspectDatabase(path: string): Promise<G8DatabaseIdentity> {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    database.pragma("query_only=ON");
    database.pragma("foreign_keys=ON");
    const schema = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name`).all();
    const integrityCheck = (database.pragma("integrity_check") as
      Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeyViolationCount = Number(database.prepare(
      "SELECT COUNT(*) FROM pragma_foreign_key_check",
    ).pluck().get());
    return {
      databaseBytes: (await stat(path)).size,
      fileSha256: await sha256File(path),
      foreignKeyViolationCount,
      integrityCheck,
      schemaSha256: sha256Text(canonicalJson(schema)),
      schemaVersion: database.pragma("user_version", { simple: true }) as number,
    };
  } finally {
    database.close();
  }
}

function maximumId(connection: Database.Database, table: string): number {
  return Number(connection.prepare(`SELECT COALESCE(MAX(id),0) FROM "${table}"`)
    .pluck().get());
}

function deterministicText(scopeSize: number, index: number): string {
  if (scopeSize === 10_000 && index === 0) return "Z".repeat(70_000);
  return `Q10K-G8 deterministic captured text for scope ${scopeSize}, page ${index}.`;
}

function deterministicUrl(scopeSize: number, index: number): string {
  if (scopeSize === 10_000 && index >= 100 && index < 200) {
    return `chrome://settings/q10k-g8-${String(index).padStart(5, "0")}`;
  }
  return `https://q10k-g8.openai.com/scope-${scopeSize}/${String(index).padStart(5, "0")}`;
}

async function deriveFixture(
  sourcePath: string,
  destinationPath: string,
): Promise<DerivedFixture> {
  await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  const database = openDatabase(destinationPath, {
    migrationClock: () => new Date(fixedClock),
    maximumMigrationVersion: q10kG8V1.fixture.expectedSchemaVersion,
  });
  const { connection } = database;
  try {
    if (database.schemaVersion !== q10kG8V1.fixture.expectedSchemaVersion) {
    throw new Error(
      `Q10K-G8 derived schema is ${database.schemaVersion}, expected ${q10kG8V1.fixture.expectedSchemaVersion}`,
    );
    }
    connection.pragma("synchronous=OFF");
    let logicalPageId = maximumId(connection, "logical_pages");
    let tabId = maximumId(connection, "tabs");
    let resourceId = maximumId(connection, "resources");
    let resourceEventId = maximumId(connection, "resource_events");
    let assignmentId = maximumId(connection, "logical_page_resource_assignments");
    let contextId = maximumId(connection, "context_entries");

    const insertResource = connection.prepare(`INSERT INTO resources
      (id,resource_key,created_at) VALUES (?,?,?)`);
    const insertResourceEvent = connection.prepare(`INSERT INTO resource_events
      (id,resource_id,version,name,kind,access_class,lifecycle_state,
       merged_into_resource_id,created_by,creation_method,supersedes_id,created_at)
      VALUES (?,?,1,?,'collection','public','active',NULL,'system','derived',NULL,?)`);
    const insertResourceHead = connection.prepare(`INSERT INTO resource_heads
      (resource_id,event_id) VALUES (?,?)`);
    const insertLogicalPage = connection.prepare(`INSERT INTO logical_pages
      (id,identity_key,url_normalized,representative_url,created_at,updated_at)
      VALUES (@id,@url,@url,@url,@at,@at)`);
    const insertPreference = connection.prepare(`INSERT INTO logical_page_preferences
      (logical_page_id,user_importance,recorded_by,record_method,
       importance_updated_at,updated_at) VALUES (?,NULL,NULL,NULL,NULL,?)`);
    const insertTab = connection.prepare(`INSERT INTO tabs
      (id,url,url_normalized,title,browser,window_id,tab_index,status,importance,
       is_open,first_seen_at,last_seen_at,closed_at,logical_page_id)
      VALUES (@id,@url,@url,@title,'q10k-g8',1,@tabIndex,'inbox',0,0,@at,@at,@at,
        @logicalPageId)`);
    const insertContent = connection.prepare(`INSERT INTO contents
      (tab_id,text,html_excerpt,summary,extracted_at,content_revision)
      VALUES (?,?,'<p>Q10K-G8</p>',NULL,?,1)`);
    const insertAssignment = connection.prepare(`INSERT INTO
      logical_page_resource_assignments
      (id,logical_page_id,action,resource_id,provenance_class,assigned_by,
       assignment_method,rule_id,confidence,source_fingerprint,supersedes_id,created_at)
      VALUES (?,?,'assigned',?,'user_manual','user','manual',NULL,NULL,?,NULL,?)`);
    const insertAssignmentHead = connection.prepare(`INSERT INTO
      logical_page_resource_heads (logical_page_id,assignment_id) VALUES (?,?)`);
    const insertContext = connection.prepare(`INSERT INTO context_entries
      (id,logical_page_id,kind,body,actor,method,visibility,confidence,
       source_fingerprint,model_provenance_json,stale_at,supersedes_id,state,
       operation,revision,idempotency_key,created_at,withdrawn_at)
      VALUES (?,?,'purpose',?,'user','manual','share_with_ai',NULL,NULL,NULL,
        NULL,NULL,'active','append',1,?,?,NULL)`);

    const scopes: FixtureScope[] = [];
    connection.transaction(() => {
      for (const size of q10kG8V1.fixture.targetSizes) {
        resourceId += 1;
        resourceEventId += 1;
        const currentResourceId = resourceId;
        insertResource.run(currentResourceId, `q10k-g8:scope:${size}`, fixtureClock);
        insertResourceEvent.run(
          resourceEventId,
          currentResourceId,
          `Q10K-G8 scope ${size}`,
          fixtureClock,
        );
        insertResourceHead.run(currentResourceId, resourceEventId);
        scopes.push({ resourceId: currentResourceId, size });

        for (let index = 0; index < size; index += 1) {
          logicalPageId += 1;
          tabId += 1;
          assignmentId += 1;
          const url = deterministicUrl(size, index);
          insertLogicalPage.run({ id: logicalPageId, url, at: fixtureClock });
          insertPreference.run(logicalPageId, fixtureClock);
          insertTab.run({
            id: tabId,
            url,
            title: `Q10K-G8 ${size} page ${String(index).padStart(5, "0")}`,
            tabIndex: index,
            at: fixtureClock,
            logicalPageId,
          });
          const missing = size === 10_000 && index >= 9_900;
          if (!missing) {
            insertContent.run(tabId, deterministicText(size, index), fixtureClock);
          }
          const assignmentFingerprint = sha256Text(
            `q10k-g8-assignment:${size}:${index}`,
          );
          insertAssignment.run(
            assignmentId,
            logicalPageId,
            currentResourceId,
            assignmentFingerprint,
            fixtureClock,
          );
          insertAssignmentHead.run(logicalPageId, assignmentId);

          const availableSnapshots = size === 10_000 ? 120 : Math.min(size, 100);
          if (index < availableSnapshots) {
            contextId += 1;
            insertContext.run(
              contextId,
              logicalPageId,
              `Shareable Q10K-G8 context for ${size}/${index}`,
              `q10k-g8-context:${size}:${index}`,
              fixtureClock,
            );
          }
        }
      }
    })();
    checkpoint(connection);
    connection.pragma("synchronous=NORMAL");
    return { database: await inspectDatabase(destinationPath), scopes };
  } finally {
    database.close();
  }
}

interface OracleCandidate {
  readonly access_class: "public";
  readonly content_revision: number | null;
  readonly extracted_at: string | null;
  readonly logical_page_id: number;
  readonly tab_id: number | null;
  readonly text: string | null;
  readonly title: string | null;
  readonly url: string;
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly byteLength: number;
  readonly text: string;
  readonly truncated: boolean;
} {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) {
    return { byteLength: encoded.byteLength, text: value, truncated: false };
  }
  let byteLength = 0;
  let text = "";
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (byteLength + bytes > maximumBytes) break;
    byteLength += bytes;
    text += character;
  }
  return { byteLength, text, truncated: true };
}

function originDigest(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return sha256Text(parsed.origin.toLowerCase());
  } catch {
    return null;
  }
}

function corpusFingerprint(
  target: ResearchPreflightRequest["target"],
  sources: readonly Record<string, unknown>[],
  snapshots: readonly Record<string, unknown>[],
): string {
  return sha256Text(canonicalJson({
    version: 1,
    target,
    sources: sources.map((source) => {
      const { exclusionReason, payload, ...identity } = source;
      return {
        ...identity,
        ...(exclusionReason === undefined || exclusionReason === null
          ? {} : { exclusionReason }),
        payload: payload === null ? null : (() => {
          const { evidenceMaterial, ...metadata } = payload as Record<string, unknown>;
          return {
            ...metadata,
            evidenceMaterialDigest: sha256Text(String(evidenceMaterial)),
          };
        })(),
      };
    }),
    ...(snapshots.length === 0 ? {} : {
      snapshots: snapshots.map((snapshot) => {
        const { material, ...identity } = snapshot;
        return {
          ...identity,
          materialDigest: sha256Text(canonicalJson(material)),
        };
      }),
    }),
  }));
}

function buildOracle(
  connection: Database.Database,
  resourceId: number,
): ResearchPreflight {
  const request: ResearchPreflightRequest = {
    ...q10kG8V1.request,
    target: { type: "resource", resourceId },
    captureIntent: {
      selectedTabIds: [...q10kG8V1.request.captureIntent.selectedTabIds],
      knownFailures: [...q10kG8V1.request.captureIntent.knownFailures],
    },
    confirmedOrigins: {
      authenticatedOriginDigests: [
        ...q10kG8V1.request.confirmedOrigins.authenticatedOriginDigests,
      ],
      sensitiveOriginDigests: [
        ...q10kG8V1.request.confirmedOrigins.sensitiveOriginDigests,
      ],
    },
  };
  const candidates = connection.prepare(`
    WITH scope AS (
      SELECT assignments.logical_page_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
       AND assignments.logical_page_id=heads.logical_page_id
      WHERE assignments.action='assigned' AND assignments.resource_id=?
    ), ranked AS (
      SELECT scope.logical_page_id,tabs.id AS tab_id,tabs.url,tabs.title,
        contents.content_revision,contents.text,contents.extracted_at,
        events.access_class,
        ROW_NUMBER() OVER (PARTITION BY scope.logical_page_id ORDER BY
          CASE WHEN contents.text IS NOT NULL AND contents.content_revision IS NOT NULL
            AND contents.extracted_at IS NOT NULL THEN 0 ELSE 1 END,
          contents.content_revision DESC,contents.extracted_at DESC,tabs.id DESC) AS rank
      FROM scope
      LEFT JOIN tabs ON tabs.logical_page_id=scope.logical_page_id
      LEFT JOIN contents ON contents.tab_id=tabs.id
      JOIN logical_page_resource_heads AS heads
        ON heads.logical_page_id=scope.logical_page_id
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
      JOIN resource_heads ON resource_heads.resource_id=assignments.resource_id
      JOIN resource_events AS events ON events.id=resource_heads.event_id
    )
    SELECT logical_page_id,tab_id,url,title,content_revision,text,extracted_at,
      access_class FROM ranked WHERE rank=1
    ORDER BY extracted_at IS NULL,extracted_at DESC,logical_page_id,tab_id
  `).all(resourceId) as OracleCandidate[];

  let included = 0;
  let includedBytes = 0;
  const sources: Record<string, unknown>[] = [];
  const manifest: ResearchPreflight["manifest"] = [];
  for (const [index, candidate] of candidates.entries()) {
    const ordinal = index + 1;
    const missing = candidate.tab_id === null || candidate.text === null ||
      candidate.content_revision === null || candidate.extracted_at === null;
    const internal = !missing && new URL(candidate.url).protocol === "chrome:";
    if (missing) {
      sources.push({
        ordinal,
        logicalPageId: candidate.logical_page_id,
        tabId: null,
        contentRevision: null,
        contentDigest: null,
        extractedAt: null,
        acquisitionMethod: "inventory",
        accessClass: candidate.access_class,
        eligibility: "not_captured",
        inclusionState: "missing",
        failureCode: null,
        includedOrder: null,
        payload: null,
      });
      manifest.push({
        sourceKind: "captured",
        acquisitionMethod: "inventory",
        ordinal,
        logicalPageId: candidate.logical_page_id,
        selectedTabId: null,
        contentRevision: null,
        contentDigest: null,
        state: "missing",
        exclusionReason: null,
        exclusionCategory: null,
        accessClass: candidate.access_class,
        originDigest: originDigest(candidate.url),
        requiresConfirmation: false,
        failureCode: null,
        capturedChunkManifest: null,
      });
      continue;
    }
    const contentDigest = sha256Text(candidate.text!);
    if (internal) {
      sources.push({
        ordinal,
        logicalPageId: candidate.logical_page_id,
        tabId: candidate.tab_id,
        contentRevision: candidate.content_revision,
        contentDigest,
        extractedAt: candidate.extracted_at,
        acquisitionMethod: "captured",
        accessClass: candidate.access_class,
        eligibility: "format_excluded",
        inclusionState: "excluded",
        exclusionReason: "format",
        includedOrder: null,
        payload: null,
      });
      manifest.push({
        sourceKind: "captured",
        acquisitionMethod: "captured",
        ordinal,
        logicalPageId: candidate.logical_page_id,
        selectedTabId: candidate.tab_id,
        contentRevision: candidate.content_revision,
        contentDigest,
        state: "excluded",
        exclusionReason: "browser_internal",
        exclusionCategory: "format",
        accessClass: candidate.access_class,
        originDigest: null,
        requiresConfirmation: false,
        failureCode: null,
        capturedChunkManifest: null,
      });
      continue;
    }
    if (included >= q10kG8V1.fixture.sourceCap) {
      sources.push({
        ordinal,
        logicalPageId: candidate.logical_page_id,
        tabId: candidate.tab_id,
        contentRevision: candidate.content_revision,
        contentDigest,
        extractedAt: candidate.extracted_at,
        acquisitionMethod: "captured",
        accessClass: candidate.access_class,
        eligibility: "eligible",
        inclusionState: "excluded",
        exclusionReason: "source_limit",
        includedOrder: null,
        payload: null,
      });
      manifest.push({
        sourceKind: "captured",
        acquisitionMethod: "captured",
        ordinal,
        logicalPageId: candidate.logical_page_id,
        selectedTabId: candidate.tab_id,
        contentRevision: candidate.content_revision,
        contentDigest,
        state: "excluded",
        exclusionReason: "source_limit",
        exclusionCategory: "limit",
        accessClass: candidate.access_class,
        originDigest: originDigest(candidate.url),
        requiresConfirmation: false,
        failureCode: null,
        capturedChunkManifest: null,
      });
      continue;
    }
    const evidence = truncateUtf8(candidate.text!, maximumSourceBytes);
    included += 1;
    includedBytes += evidence.byteLength;
    const chunkManifest = {
      version: "captured_text_chunks:v1" as const,
      byteStart: 0 as const,
      byteEnd: evidence.byteLength,
      chunkDigest: sha256Text(evidence.text),
      truncated: evidence.truncated,
    };
    sources.push({
      ordinal,
      logicalPageId: candidate.logical_page_id,
      tabId: candidate.tab_id,
      contentRevision: candidate.content_revision,
      contentDigest,
      extractedAt: candidate.extracted_at,
      acquisitionMethod: "captured",
      accessClass: candidate.access_class,
      eligibility: "eligible",
      inclusionState: "included",
      includedOrder: included,
      payload: {
        url: candidate.url,
        title: candidate.title ?? "",
        evidenceMaterial: evidence.text,
        chunkManifest,
      },
    });
    manifest.push({
      sourceKind: "captured",
      acquisitionMethod: "captured",
      ordinal,
      logicalPageId: candidate.logical_page_id,
      selectedTabId: candidate.tab_id,
      contentRevision: candidate.content_revision,
      contentDigest,
      state: "captured",
      exclusionReason: null,
      exclusionCategory: null,
      accessClass: candidate.access_class,
      originDigest: originDigest(candidate.url),
      requiresConfirmation: false,
      failureCode: null,
      capturedChunkManifest: chunkManifest,
    });
  }

  const contextRows = connection.prepare(`
    SELECT entries.id,entries.logical_page_id,entries.kind,entries.body,
      entries.actor,entries.method,entries.stale_at,entries.created_at
    FROM context_entries AS entries
    WHERE entries.logical_page_id IN (
      SELECT assignments.logical_page_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
      WHERE assignments.action='assigned' AND assignments.resource_id=?
    )
      AND entries.visibility='share_with_ai' AND entries.state='active'
      AND (entries.stale_at IS NULL OR julianday(entries.stale_at)>julianday(?))
      AND NOT EXISTS (SELECT 1 FROM context_entries AS newer
        WHERE newer.supersedes_id=entries.id AND newer.visibility='share_with_ai')
      AND entries.actor='user'
    ORDER BY entries.logical_page_id,entries.revision,entries.id LIMIT 100
  `).all(resourceId, fixedClock) as Array<{
    actor: string;
    body: string;
    created_at: string;
    id: number;
    kind: string;
    logical_page_id: number;
    method: string;
    stale_at: string | null;
  }>;
  const snapshotDrafts = contextRows.map((row, index) => {
    const material = {
      kind: row.kind,
      body: row.body,
      bodyTruncated: false,
      actor: row.actor,
      method: row.method,
      staleAt: row.stale_at,
      createdAt: row.created_at,
      reviewVerdict: null,
    };
    return {
      kind: "page_context" as const,
      ordinal: index + 1,
      contextEntryId: row.id,
      logicalPageId: row.logical_page_id,
      snapshotDigest: sha256Text(canonicalJson(material)),
      material,
    };
  });
  const snapshots: ResearchPreflight["snapshots"] = snapshotDrafts.map(
    ({ material, ...snapshot }) => ({
      ...snapshot,
      materialBytes: Buffer.byteLength(canonicalJson(material), "utf8"),
      truncated: false,
    }),
  );
  const corpus = corpusFingerprint(request.target, sources, snapshotDrafts);
  const captured = manifest.filter((entry) =>
    entry.state === "captured" || entry.state === "excluded").length;
  const eligible = manifest.filter((entry) => entry.state === "captured" ||
    entry.exclusionReason === "source_limit" ||
    entry.exclusionReason === "corpus_byte_limit").length;
  const missing = manifest.filter((entry) => entry.state === "missing").length;
  const failed = manifest.filter((entry) => entry.state === "failed").length;
  const snapshotBytes = snapshotDrafts.reduce((total, snapshot) =>
    total + Buffer.byteLength(canonicalJson(snapshot.material), "utf8"), 0);
  const questionBytes = Buffer.byteLength(request.question, "utf8");
  const calls = included === 0 ? 0 : 1;
  const estimate = {
    estimateVersion: "research_estimate:v1" as const,
    estimateKind: "reservation_envelope" as const,
    calls,
    inputTokens: calls === 0 ? 0 : Math.ceil(
      (includedBytes + snapshotBytes + questionBytes) / 4,
    ) + 512,
    outputTokens: calls === 0 ? 0 : Math.min(8_192, Math.max(1_024, 256 + 64 * included)),
    costUsd: calls === 0 ? 0 : request.budget.maxCostUsd,
    wallTimeMs: calls === 0 ? 0 : request.budget.maxWallTimeMs,
  };
  const limitations = [...new Set(manifest.flatMap((entry) =>
    entry.exclusionReason === null ? [] : [entry.exclusionReason]))].sort();
  const withoutApproval = {
    version: 1 as const,
    target: request.target,
    corpusFingerprint: corpus,
    coverage: {
      discovered: manifest.length,
      captured,
      eligible,
      used: 0,
      missing,
      failed,
    },
    approvedBudget: request.budget,
    acquisitionLevel: "captured_only" as const,
    manifest,
    snapshots,
    confirmationRequirements: {
      authenticatedOriginDigests: [] as string[],
      sensitiveOriginDigests: [] as string[],
    },
    estimate,
    requiresConfirmation: false,
    limitations,
  };
  const approvalFingerprint = sha256Text(canonicalJson({
    version: "research_workflow_approval:v1",
    workflowRef: { id: "research_workflow:c81:v1", version: 1 },
    request,
    preflight: withoutApproval,
  }));
  return { ...withoutApproval, confirmationDisplay: [], approvalFingerprint };
}

interface StatementSample {
  readonly preparedStatementExecutions: number;
  readonly sources: readonly string[];
  readonly totalChangesDelta: number;
  readonly uniquePreparedStatements: number;
  readonly writeStatementExecutions: number;
}

interface InstrumentedStatement {
  readonly database: Database.Database;
  readonly readonly: boolean;
  readonly source: string;
}

interface ActiveStatementSample {
  executions: number;
  sources: Set<string>;
  writeExecutions: number;
}

function installStatementProbe(): {
  readonly databases: Set<Database.Database>;
  begin(): void;
  finish(totalChangesDelta: number): StatementSample;
  restore(): void;
} {
  const probeDatabase = new Database(":memory:");
  const probeStatement = probeDatabase.prepare("SELECT 1");
  const statementPrototype = Object.getPrototypeOf(probeStatement) as
    Record<string, (...args: unknown[]) => unknown>;
  const databasePrototype = Object.getPrototypeOf(probeDatabase) as
    Record<string, (...args: unknown[]) => unknown>;
  const originalPrepare = databasePrototype.prepare!;
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  const databases = new Set<Database.Database>();
  let active: ActiveStatementSample | null = null;

  databasePrototype.prepare = function(this: Database.Database, ...args: unknown[]) {
    const statement = Reflect.apply(originalPrepare, this, args) as InstrumentedStatement;
    databases.add(statement.database);
    return statement;
  };
  for (const method of ["get", "all", "run", "iterate"] as const) {
    const original = statementPrototype[method]!;
    originals.set(method, original);
    statementPrototype[method] = function(this: InstrumentedStatement, ...args: unknown[]) {
      if (active !== null) {
        active.executions += 1;
        active.sources.add(this.source);
        if (!this.readonly) active.writeExecutions += 1;
      }
      return Reflect.apply(original, this, args);
    };
  }
  probeDatabase.close();
  databases.clear();

  return {
    databases,
    begin() {
      if (active !== null) throw new Error("Q10K-G8 statement sample is already active");
      active = { executions: 0, sources: new Set(), writeExecutions: 0 };
    },
    finish(totalChangesDelta) {
      if (active === null) throw new Error("Q10K-G8 statement sample is not active");
      const sample = {
        preparedStatementExecutions: active.executions,
        sources: [...active.sources].sort(),
        totalChangesDelta,
        uniquePreparedStatements: active.sources.size,
        writeStatementExecutions: active.writeExecutions,
      };
      active = null;
      return sample;
    },
    restore() {
      active = null;
      databasePrototype.prepare = originalPrepare;
      for (const [method, original] of originals) statementPrototype[method] = original;
    },
  };
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * value / 100) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

async function measureScopes(
  databasePath: string,
  scopes: readonly FixtureScope[],
  samples: number,
  warmups: number,
): Promise<{
  readonly aggregateTotalChangesDelta: number;
  readonly before: G8DatabaseIdentity;
  readonly scopes: readonly G8ScopeTiming[];
}> {
  const probe = installStatementProbe();
  const app = createApp({
    databasePath,
    featureFlags: q10kG8V1.featureProfile,
    logger: false,
    localDevProxySecret: localBootstrapSecret,
    clock: () => new Date(fixedClock),
    migrationClock: () => new Date(fixedClock),
    maximumMigrationVersion: q10kG8V1.fixture.expectedSchemaVersion,
  });
  try {
    await app.ready();
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/local/session/bootstrap",
      headers: { "x-tabhub-dev-proxy-secret": localBootstrapSecret },
    });
    if (bootstrap.statusCode !== 204) {
      throw new Error(`Q10K-G8 bootstrap returned ${bootstrap.statusCode}`);
    }
    const rawCookie = bootstrap.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)
      ?.split(";", 1)[0];
    if (cookie === undefined || cookie.length === 0) {
      throw new Error("Q10K-G8 bootstrap returned no session cookie");
    }
    const applicationDatabase = [...probe.databases].find((candidate) =>
      candidate.open && resolve(candidate.name) === resolve(databasePath));
    if (applicationDatabase === undefined) {
      throw new Error("Q10K-G8 could not identify the application database connection");
    }
    checkpoint(applicationDatabase);
    const before = await inspectDatabase(databasePath);
    const totalChanges = applicationDatabase.prepare("SELECT total_changes()")
      .pluck();
    const aggregateStart = Number(totalChanges.get());
    const scopeResults: G8ScopeTiming[] = [];
    for (const scope of scopes) {
      const oracle = buildOracle(applicationDatabase, scope.resourceId);
      if (oracle.manifest.length !== scope.size) {
        throw new Error(`Q10K-G8 oracle scope ${scope.size} has ${oracle.manifest.length} rows`);
      }
      const oracleCanonical = canonicalJson(oracle);
      const oracleFingerprint = sha256Text(oracleCanonical);
      const durations: number[] = [];
      const statementSamples: StatementSample[] = [];
      let oracleMatches = 0;
      const execute = async (measured: boolean) => {
        const changesBefore = Number(totalChanges.get());
        probe.begin();
        const startedAt = performance.now();
        const response = await app.inject({
          method: "POST",
          url: "/api/research/preflight",
          headers: { cookie, "sec-fetch-site": q10kG8V1.authProfile.sameSiteHeader },
          payload: {
            ...q10kG8V1.request,
            target: { type: "resource", resourceId: scope.resourceId },
          },
        });
        const duration = performance.now() - startedAt;
        const changesAfter = Number(totalChanges.get());
        const statementSample = probe.finish(changesAfter - changesBefore);
        if (response.statusCode !== 200) {
          throw new Error(
            `Q10K-G8 scope ${scope.size} returned ${response.statusCode}: ${response.body}`,
          );
        }
        const actualCanonical = canonicalJson(response.json());
        if (actualCanonical !== oracleCanonical) {
          throw new Error(`Q10K-G8 scope ${scope.size} differs from independent oracle`);
        }
        oracleMatches += 1;
        if (statementSample.preparedStatementExecutions >
            q10kG8V1.statementExecutionLimit) {
          throw new Error(`Q10K-G8 scope ${scope.size} exceeded SQL statement limit`);
        }
        if (statementSample.writeStatementExecutions !== 0 ||
            statementSample.totalChangesDelta !== 0) {
          throw new Error(`Q10K-G8 scope ${scope.size} wrote during preflight`);
        }
        if (measured) {
          durations.push(duration);
          statementSamples.push(statementSample);
        }
      };
      for (let warmup = 0; warmup < warmups; warmup += 1) await execute(false);
      for (let sample = 0; sample < samples; sample += 1) await execute(true);
      const sorted = [...durations].sort((left, right) => left - right);
      const p95Ms = rounded(percentile(sorted, 95));
      const maximumPreparedStatementExecutions = Math.max(
        ...statementSamples.map((sample) => sample.preparedStatementExecutions),
      );
      const maximumUniquePreparedStatements = Math.max(
        ...statementSamples.map((sample) => sample.uniquePreparedStatements),
      );
      const maximumWriteStatementExecutions = Math.max(
        ...statementSamples.map((sample) => sample.writeStatementExecutions),
      );
      const maximumTotalChangesDelta = Math.max(
        ...statementSamples.map((sample) => sample.totalChangesDelta),
      );
      scopeResults.push({
        coverage: oracle.coverage,
        includedSourceCount: oracle.manifest.filter((entry) =>
          entry.state === "captured").length,
        manifestSize: oracle.manifest.length,
        maximumPreparedStatementExecutions,
        maximumTotalChangesDelta,
        maximumUniquePreparedStatements,
        maximumWriteStatementExecutions,
        oracleFingerprint,
        oracleMatches,
        p50Ms: rounded(percentile(sorted, 50)),
        p95LimitMs: q10kG8V1.p95LimitMs,
        p95Ms,
        passed: p95Ms <= q10kG8V1.p95LimitMs &&
          maximumPreparedStatementExecutions <= q10kG8V1.statementExecutionLimit &&
          maximumWriteStatementExecutions === 0 && maximumTotalChangesDelta === 0,
        resourceId: scope.resourceId,
        samples,
        snapshotCount: oracle.snapshots.length,
        timingsMs: durations.map(rounded),
        warmups,
      });
    }
    return {
      aggregateTotalChangesDelta: Number(totalChanges.get()) - aggregateStart,
      before,
      scopes: scopeResults,
    };
  } finally {
    await app.close();
    probe.restore();
  }
}

async function runWithIdentity(
  options: RunG8BaselineOptions,
  identity: G8RunIdentity,
): Promise<G8BaselineRun> {
  if (identity.expectedSourcePath !== null &&
      resolve(options.sourcePath) !== resolve(identity.expectedSourcePath)) {
    throw new Error("Q10K-G8 accepted source path mismatch");
  }
  const sourceBefore = await stat(options.sourcePath);
  const sourceSha256 = await sha256File(options.sourcePath);
  if (sourceSha256 !== identity.expectedSourceSha256.toLowerCase()) {
    throw new Error(
      `Q10K-G8 source SHA-256 mismatch: expected ${identity.expectedSourceSha256}, got ${sourceSha256}`,
    );
  }
  await mkdir(options.workDirectory, { recursive: true });
  if ((await readdir(options.workDirectory)).length !== 0) {
    throw new Error(`G8 baseline work directory must be empty: ${options.workDirectory}`);
  }
  const claim = await open(join(options.workDirectory, ".g8-baseline-claimed"), "wx");
  try {
    await claim.writeFile(`${JSON.stringify({
      contractHash: identity.contractHash,
      official: identity.official,
    })}\n`);
  } finally {
    await claim.close();
  }

  const primaryPath = join(options.workDirectory, "S10K-G8-v1.sqlite");
  const replicaPath = join(options.workDirectory, "S10K-G8-v1-replica.sqlite");
  const measurementPath = join(options.workDirectory, "S10K-G8-v1-measurement.sqlite");
  const primary = await deriveFixture(options.sourcePath, primaryPath);
  const replica = await deriveFixture(options.sourcePath, replicaPath);
  const exactBytes = primary.database.fileSha256 === replica.database.fileSha256 &&
    primary.database.databaseBytes === replica.database.databaseBytes;
  if (!exactBytes || canonicalJson(primary.scopes) !== canonicalJson(replica.scopes)) {
    throw new Error("Independent Q10K-G8 fixture derivations differ");
  }
  for (const fixture of [primary.database, replica.database]) {
    if (fixture.schemaVersion !== q10kG8V1.fixture.expectedSchemaVersion ||
        canonicalJson(fixture.integrityCheck) !== canonicalJson(["ok"]) ||
        fixture.foreignKeyViolationCount !== 0) {
      throw new Error("Q10K-G8 derived fixture failed schema/integrity checks");
    }
  }

  await copyFile(primaryPath, measurementPath, fsConstants.COPYFILE_EXCL);
  const measured = await measureScopes(
    measurementPath,
    primary.scopes,
    identity.samples,
    identity.warmups,
  );
  await checkpointPath(measurementPath);
  const measurementAfter = await inspectDatabase(measurementPath);
  await removeEmptyCheckpointSidecars(measurementPath);
  const measurementBytesUnchanged = measured.before.fileSha256 ===
    measurementAfter.fileSha256 && measured.before.databaseBytes ===
    measurementAfter.databaseBytes;
  if (!measurementBytesUnchanged || measured.aggregateTotalChangesDelta !== 0) {
    throw new Error("Q10K-G8 measured preflight changed the database");
  }
  if (measurementAfter.integrityCheck.length !== 1 ||
      measurementAfter.integrityCheck[0] !== "ok" ||
      measurementAfter.foreignKeyViolationCount !== 0) {
    throw new Error("Q10K-G8 measurement database failed integrity checks");
  }

  const sourceAfter = await stat(options.sourcePath);
  const sourceAfterSha256 = await sha256File(options.sourcePath);
  const sourceUnchanged = sourceAfterSha256 === sourceSha256 &&
    sourceAfter.size === sourceBefore.size && sourceAfter.mtimeMs === sourceBefore.mtimeMs;
  if (!sourceUnchanged) throw new Error("Accepted S10K source changed during Q10K-G8");

  const runnerSourcePath = fileURLToPath(import.meta.url);
  const runnerSourceSha256 = await sha256File(runnerSourcePath);
  const correctnessPassed = exactBytes && measurementBytesUnchanged &&
    measured.aggregateTotalChangesDelta === 0 && measured.scopes.every((scope) =>
      scope.oracleMatches === identity.samples + identity.warmups &&
      scope.maximumPreparedStatementExecutions <= q10kG8V1.statementExecutionLimit &&
      scope.maximumWriteStatementExecutions === 0 &&
      scope.maximumTotalChangesDelta === 0) &&
    measured.scopes.at(-1)?.manifestSize === 10_000 &&
    measured.scopes.at(-1)?.snapshotCount === 100;
  const performancePassed = measured.scopes.every(({ p95Ms }) =>
    p95Ms <= q10kG8V1.p95LimitMs);
  const result: G8BaselineResult = {
    contractHash: identity.contractHash,
    correctnessPassed,
    databaseDeterminism: {
      exactBytes,
      primary: primary.database,
      replica: replica.database,
    },
    fixture: identity.fixture,
    hashes: {
      contractSha256: identity.contractHash,
      primaryDerivedSha256: primary.database.fileSha256,
      replicaDerivedSha256: replica.database.fileSha256,
      runnerSourceSha256,
      sourceSha256,
    },
    measurement: {
      after: measurementAfter,
      before: measured.before,
      bytesUnchanged: measurementBytesUnchanged,
      totalChangesDelta: measured.aggregateTotalChangesDelta,
    },
    official: identity.official,
    passed: identity.official && correctnessPassed && performancePassed,
    performancePassed,
    querySet: identity.querySet,
    runtime: {
      command: process.argv,
      head: gitHead(),
      node: process.version,
      platform: process.platform,
    },
    scopes: measured.scopes,
    source: {
      afterSha256: sourceAfterSha256,
      beforeMtimeMs: sourceBefore.mtimeMs,
      beforeSha256: sourceSha256,
      bytes: sourceBefore.size,
      path: options.sourcePath,
      unchanged: sourceUnchanged,
    },
  };
  const artifactPath = join(options.workDirectory, identity.artifactName);
  const temporaryArtifactPath = `${artifactPath}.tmp`;
  await writeFile(temporaryArtifactPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporaryArtifactPath, artifactPath);
  const artifactSha256 = await sha256File(artifactPath);
  const evidence: G8BaselineEvidence = {
    artifactSha256,
    contractSha256: identity.contractHash,
    primaryDerivedSha256: primary.database.fileSha256,
    replicaDerivedSha256: replica.database.fileSha256,
    runnerSourceSha256,
    sourceSha256,
  };
  const evidencePath = join(options.workDirectory,
    identity.artifactName.replace(/\.json$/, ".evidence.json"));
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return { artifactPath, evidence, evidencePath, result };
}

export async function runG8Baseline(
  options: RunG8BaselineOptions,
): Promise<G8BaselineRun> {
  return runWithIdentity(options, {
    artifactName: "Q10K-G8-v1.json",
    contractHash: q10kG8V1Hash,
    expectedSourcePath: q10kG8V1.fixture.acceptedSourcePath,
    expectedSourceSha256: q10kG8V1.fixture.acceptedSourceSha256,
    fixture: {
      acceptedSource: q10kG8V1.fixture.acceptedSource,
      acceptedSourceSha256: q10kG8V1.fixture.acceptedSourceSha256,
      derivedFixture: q10kG8V1.fixture.derivedFixture,
      expectedSchemaVersion: q10kG8V1.fixture.expectedSchemaVersion,
    },
    official: true,
    querySet: q10kG8V1.querySet,
    samples: q10kG8V1.samples,
    warmups: q10kG8V1.warmups,
  });
}

/** Disposable full-shape runner. It can never emit or PASS as Q10K-G8-v1. */
export async function runG8CandidateBaselineForTest(
  options: RunG8BaselineOptions & {
    readonly expectedSourceSha256: string;
    readonly samples?: number;
    readonly warmups?: number;
  },
): Promise<G8BaselineRun> {
  const fixture = {
    acceptedSource: "noncanonical-test-candidate",
    acceptedSourceSha256: options.expectedSourceSha256.toLowerCase(),
    derivedFixture: "noncanonical-G8-test-candidate",
    expectedSchemaVersion: q10kG8V1.fixture.expectedSchemaVersion,
  };
  const querySet = "Q10K-G8-candidate";
  return runWithIdentity(options, {
    artifactName: "Q10K-G8-candidate.json",
    contractHash: contractHash({ ...q10kG8V1, fixture, querySet }),
    expectedSourcePath: null,
    expectedSourceSha256: fixture.acceptedSourceSha256,
    fixture,
    official: false,
    querySet,
    samples: options.samples ?? 1,
    warmups: options.warmups ?? 0,
  });
}
