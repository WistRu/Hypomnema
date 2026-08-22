import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  personalPriorityRulesetVersionSchema,
  personalPriorityRulesStateResponseSchema,
  type PersonalPriorityRule,
} from "@tabhub/shared";
import * as shared from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import {
  baselinePriorityRulesetRef,
  createPersonalPriorityRulesCatalog,
  PersonalPriorityRulesError,
  personalPriorityRequestFingerprint,
} from "../src/personal-priority-rules.js";
import { createPriorityFeatureCatalog } from "../src/priority-feature-catalog.js";
import { compilePriorityRuleNaturalLanguageV1 } from
  "../src/priority-rule-compiler.js";

const now = "2026-08-13T12:00:00.000Z";
const rule: PersonalPriorityRule = {
  ruleKey: "personal.acceptance.c60c",
  priority: 500,
  label: "C60c acceptance",
  appliesTo: "page",
  when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
  effect: { scoreDelta: 5 },
};

function fingerprint<T extends object>(payload: T): T & { requestFingerprint: string } {
  return { ...payload, requestFingerprint: personalPriorityRequestFingerprint(payload) };
}

function expectRuleError(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PersonalPriorityRulesError);
  expect((thrown as PersonalPriorityRulesError).code).toBe(code);
}

describe("C60c personal-priority integration acceptance", () => {
  it("keeps the shared browser helper byte-identical to the server lifecycle fingerprint", async () => {
    const candidate = (shared as unknown as Record<string, unknown>)[
      "personalPriorityRequestFingerprint"
    ];
    expect(candidate, "shared must export the browser-safe lifecycle fingerprint helper")
      .toEqual(expect.any(Function));
    const sharedFingerprint = candidate as
      (payload: unknown) => string | Promise<string>;
    const payloads = [
      {
        kind: "save",
        draft: { kind: "structured", additions: [rule] },
        expectedLatestVersion: 3,
        expectedActiveRef: { rulesetId: 2, version: 2 },
      },
      {
        kind: "rollback",
        target: { rulesetId: 2, version: 1 },
        expectedActiveRef: { rulesetId: 2, version: 2 },
      },
    ];
    for (const payload of payloads) {
      await expect(Promise.resolve(sharedFingerprint(payload))).resolves
        .toBe(personalPriorityRequestFingerprint(payload));
    }
  });

  it("rejects a preview-confirmed save after a pointer-only concurrent activation", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-13T11:00:00.000Z"),
    });
    try {
      const rules = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        writerEnabled: true,
        featureCatalog: createPriorityFeatureCatalog(database.connection),
      });
      const first = rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      rules.change(fingerprint({
        kind: "activate" as const,
        target: first.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      const secondRule = { ...rule, effect: { scoreDelta: 10 } };
      const second = rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [secondRule] },
        expectedLatestVersion: first.latestVersion,
        expectedActiveRef: first.target,
      }));
      const preview = rules.preview({
        kind: "structured",
        additions: [{ ...rule, effect: { scoreDelta: 15 } }],
      }) as ReturnType<typeof rules.preview> & {
        comparedActiveRef: { rulesetId: number; version: number };
        comparedActiveAstHash: string;
      };
      const activeBeforePreview = rules.read().versions.find((version) => version.active)!;
      expect(preview.comparedActiveRef).toEqual(first.target);
      expect(preview.comparedActiveAstHash).toBe(activeBeforePreview.astHash);

      rules.change(fingerprint({
        kind: "activate" as const,
        target: second.target,
        expectedActiveRef: first.target,
      }));
      const versionCountBefore = database.connection.prepare(
        "SELECT COUNT(*) FROM priority_rule_versions",
      ).pluck().get();
      const payload = {
        kind: "save" as const,
        draft: {
          kind: "structured" as const,
          additions: [{ ...rule, effect: { scoreDelta: 15 } }],
        },
        expectedLatestVersion: second.latestVersion,
        expectedActiveRef: preview.comparedActiveRef,
      };
      expectRuleError(
        () => rules.change(fingerprint(payload) as never),
        "PRIORITY_RULESET_CONFLICT",
      );
      expect(database.connection.prepare("SELECT COUNT(*) FROM priority_rule_versions")
        .pluck().get()).toBe(versionCountBefore);
    } finally {
      database.close();
    }
  });

  it("returns deterministic display metadata with every preview example", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-13T11:00:00.000Z"),
    });
    try {
      database.connection.exec(`
        INSERT INTO logical_pages (
          id,identity_key,url_normalized,representative_url,created_at,updated_at
        ) VALUES (
          1,'https://preview-display.test/page','https://preview-display.test/page',
          'https://preview-display.test/page','${now}','${now}'
        );
        INSERT INTO tabs (
          id,url,url_normalized,title,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id
        ) VALUES (
          1,'https://preview-display.test/page','https://preview-display.test/page',
          'Preview display title','chrome','inbox',0,1,'${now}','${now}',1
        );
      `);
      const rules = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: createPriorityFeatureCatalog(database.connection),
      });
      const preview = rules.preview({ kind: "structured", additions: [] }) as
        ReturnType<typeof rules.preview> & { examples: Array<{
          display: { title: string | null; representativeUrl: string };
        }> };
      expect(preview.examples).toHaveLength(1);
      expect(preview.examples[0]!.display).toEqual({
        title: "Preview display title",
        representativeUrl: "https://preview-display.test/page",
      });
    } finally {
      database.close();
    }
  });

  it("keeps every frozen shared grammar example executable by its matching compiler", () => {
    const grammar = (shared as unknown as Record<string, unknown>)[
      "personalPriorityNaturalLanguageGrammarV1"
    ] as { locales: Record<"en" | "ru", { examples: readonly string[] }> };
    expect(grammar, "shared must export the compiler grammar consumed by Web").toBeDefined();
    for (const locale of ["en", "ru"] as const) {
      for (const source of grammar.locales[locale].examples) {
        expect(compilePriorityRuleNaturalLanguageV1({ locale, source }).additions.length)
          .toBeGreaterThan(0);
      }
    }
  });

  it("keeps 1,001 immutable versions readable through a bounded state and exact-by-ref rollback access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-c60c-history-"));
    const databasePath = join(directory, "history.sqlite");
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-13T11:00:00.000Z"),
    });
    let rulesetId = 0;
    try {
      const rules = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        writerEnabled: true,
        featureCatalog: createPriorityFeatureCatalog(database.connection),
      });
      const first = rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      rulesetId = first.target.rulesetId;
      const seed = database.connection.prepare(`SELECT rule_ast_json,natural_language_source
        FROM priority_rule_versions WHERE ruleset_id=? AND version=1`).get(
          first.target.rulesetId,
        ) as { rule_ast_json: string; natural_language_source: string | null };
      const insert = database.connection.prepare(`INSERT INTO priority_rule_versions
        (ruleset_id,version,rule_ast_json,natural_language_source,created_by,created_at)
        VALUES (?,?,?,?, 'user',?)`);
      database.connection.transaction(() => {
        for (let version = 2; version <= 1_001; version += 1) {
          insert.run(first.target.rulesetId, version, seed.rule_ast_json,
            seed.natural_language_source, now);
        }
      }).immediate();

    } finally {
      database.close();
    }
    const secret = "c60c-history-local-bootstrap";
    const app = createApp({
      databasePath,
      featureFlags: {
        context: false,
        logicalImportance: false,
        resources: false,
        priorityAssessmentWriter: true,
        priorityPersonalization: true,
        priorityReaders: true,
        priorityShadow: false,
        research: false,
      },
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date(now),
    });
    try {
      await app.ready();
      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": secret },
      });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const headers = { cookie, "sec-fetch-site": "same-origin" };
      const stateResponse = await app.inject({
        method: "GET",
        url: "/api/personalization/rules",
        headers,
      });
      expect(stateResponse.statusCode).toBe(200);
      const state = personalPriorityRulesStateResponseSchema.parse(stateResponse.json());
      expect(state.latestVersion).toBe(1_001);
      expect((state as typeof state & { versionCount: number }).versionCount).toBe(1_001);
      expect((state as typeof state & { historyTruncated: boolean }).historyTruncated)
        .toBe(true);
      expect(state.versions).toHaveLength(1_000);
      expect(state.versions[0]!.ref.version).toBe(1_001);
      expect(state.versions.at(-1)!.ref.version).toBe(2);

      const exactResponse = await app.inject({
        method: "GET",
        url: `/api/personalization/rules/versions/${rulesetId}/1`,
        headers,
      });
      expect(exactResponse.statusCode).toBe(200);
      const exact = personalPriorityRulesetVersionSchema.parse(exactResponse.json());
      expect(exact.ref).toEqual({ rulesetId, version: 1 });

      const rollbackPayload = {
        kind: "rollback" as const,
        target: exact.ref,
        expectedActiveRef: baselinePriorityRulesetRef,
      };
      const rollback = await app.inject({
        method: "POST",
        url: "/api/personalization/rules/rollback",
        headers,
        payload: fingerprint(rollbackPayload),
      });
      expect(rollback.statusCode).toBe(200);
      expect(rollback.json()).toMatchObject({ activeRef: exact.ref, target: exact.ref });
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies needs-review to canonical and physical Library bulk sets with logical counts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-c60c-bulk-review-"));
    const databasePath = join(directory, "bulk.sqlite");
    const secret = "c60c-bulk-local-bootstrap";
    const app = createApp({
      databasePath,
      featureFlags: {
        context: true,
        logicalImportance: true,
        resources: false,
        priorityAssessmentWriter: false,
        priorityPersonalization: true,
        priorityReaders: true,
        priorityShadow: false,
        research: false,
      },
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date(now),
      migrationClock: () => new Date(now),
    });
    try {
      const ingest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "123e4567-e89b-42d3-a456-426614174060",
          tabs: [
            { tabId: 101, windowId: 1, index: 0, title: "Review copy one",
              url: "https://bulk-review.test/review" },
            { tabId: 102, windowId: 1, index: 1, title: "Review copy two",
              url: "https://bulk-review.test/review" },
            { tabId: 201, windowId: 1, index: 2, title: "No review",
              url: "https://bulk-review.test/no-review" },
          ],
        },
      });
      expect(ingest.statusCode).toBe(200);
      const database = openDatabase(databasePath);
      let reviewLogicalPageId = 0;
      let reviewTabId = 0;
      try {
        const pageRows = database.connection.prepare(`SELECT logical_pages.id,
          logical_pages.representative_url,tabs.id AS tab_id FROM logical_pages
          JOIN tabs ON tabs.logical_page_id=logical_pages.id ORDER BY logical_pages.id`).all() as
          Array<{ id: number; representative_url: string; tab_id: number }>;
        const uniquePages = [...new Map(pageRows.map((row) => [row.id, row])).values()];
        reviewLogicalPageId = uniquePages.find((row) =>
          row.representative_url.endsWith("/review"))!.id;
        reviewTabId = uniquePages.find((row) => row.id === reviewLogicalPageId)!.tab_id;
        const features = createPriorityFeatureCatalog(database.connection);
        const projections = features.previewBatch(uniquePages.map((row) => ({
          type: "page" as const,
          logicalPageId: row.id,
        })), now);
        const insert = database.connection.prepare(`INSERT INTO priority_assessments (
          id,logical_page_id,agent_score,agent_band,confidence,needs_review,
          reasons_json,missing_signals_json,ruleset_id,ruleset_version,
          feature_fingerprint,assessment_method,model_provenance_json,revision,evaluated_at
        ) VALUES (?, ?, 40, 'medium', 0.9, ?, '[]', '[]', 1, 1, ?,
          'rule', NULL, 1, ?)`);
        projections.forEach((projection, index) => insert.run(
          index + 1,
          projection.subject.type === "page" ? projection.subject.logicalPageId : 0,
          projection.subject.type === "page" &&
            projection.subject.logicalPageId === reviewLogicalPageId ? 1 : 0,
          projection.featureFingerprint,
          now,
        ));
      } finally {
        database.close();
      }
      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": secret },
      });
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const localHeaders = { cookie, "sec-fetch-site": "same-origin" };
      for (const [prefix, headers] of [
        ["/api", undefined],
        ["/api/local", localHeaders],
      ] as const) {
        const canonical = await app.inject({
          method: "GET",
          url: `${prefix}/tabs/bulk-ids?needs_review=true`,
          ...(headers === undefined ? {} : { headers }),
        });
        expect(canonical.statusCode).toBe(200);
        expect(canonical.json()).toEqual({ ids: [reviewTabId], logicalPageCount: 1 });

        const physical = await app.inject({
          method: "GET",
          url: `${prefix}/tab-instances/library-bulk?needs_review=true`,
          ...(headers === undefined ? {} : { headers }),
        });
        expect(physical.statusCode).toBe(200);
        expect(physical.json()).toMatchObject({ total: 2, logicalPageCount: 1 });
        expect(physical.json().items).toHaveLength(2);
        expect(new Set(physical.json().items.map(
          (item: { canonicalTabId: number }) => item.canonicalTabId,
        ))).toEqual(new Set([reviewTabId]));
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed instead of broadening needs-review bulk sets when personalization is off", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-c60c-bulk-off-"));
    const app = createApp({
      databasePath: join(directory, "off.sqlite"),
      featureFlags: {
        context: false,
        logicalImportance: false,
        resources: false,
        priorityAssessmentWriter: false,
        priorityPersonalization: false,
        priorityReaders: true,
        priorityShadow: false,
        research: false,
      },
      logger: false,
      clock: () => new Date(now),
      migrationClock: () => new Date(now),
    });
    try {
      for (const url of [
        "/api/tabs/bulk-ids?needs_review=true",
        "/api/tab-instances/library-bulk?needs_review=true",
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(409);
        expect(response.json()).toMatchObject({
          error: "FEATURE_DISABLED",
          feature: "priorityPersonalization",
        });
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times out when the final preview batch crosses the wall limit", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-13T11:00:00.000Z"),
    });
    let monotonicMs = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    try {
      const subject = { type: "page" as const, logicalPageId: 1 };
      const rules = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: {
          listSubjectPage: () => ({ items: [subject], nextAfter: null }),
          previewBatch: () => {
            monotonicMs = 60_001;
            return [{
              subject,
              features: { is_open: true, has_captured_content: true },
              eligibility: { kind: "eligible" as const },
              featureFingerprint: "d".repeat(64),
            }];
          },
          readBatch: () => [],
        },
      });
      expectRuleError(
        () => rules.preview({ kind: "structured", additions: [] }),
        "PRIORITY_RULE_PREVIEW_TIMEOUT",
      );
    } finally {
      nowSpy.mockRestore();
      database.close();
    }
  });
});
