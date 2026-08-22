import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  createPersonalPriorityRulesCatalog,
  PersonalPriorityRulesError,
} from "../src/personal-priority-rules.js";
import type { PriorityFeatureCatalog } from "../src/priority-feature-catalog.js";

const now = "2026-08-13T09:00:00.000Z";

function fixture(pageCount: number) {
  const database = openDatabase(":memory:", {
    migrationClock: () => new Date("2026-08-13T08:00:00.000Z"),
  });
  const insertPage = database.connection.prepare(`INSERT INTO logical_pages (
    id, identity_key, url_normalized, representative_url, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertTab = database.connection.prepare(`INSERT INTO tabs (
    id, url, url_normalized, title, browser, status, importance, is_open,
    first_seen_at, last_seen_at, logical_page_id
  ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`);
  database.connection.transaction(() => {
    for (let index = 1; index <= pageCount; index += 1) {
      const url = `https://preview-acceptance.test/${index}`;
      insertPage.run(index, url, url, url, now, now);
      insertTab.run(index, url, url, `Page ${index}`, "chrome", "inbox", now, now, index);
    }
  }).immediate();
  return database;
}

function databaseSnapshot(connection: ReturnType<typeof fixture>["connection"]): string {
  const tables = connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[];
  const contents = tables.map((table) => ({
    table,
    rows: connection.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all(),
  }));
  return createHash("sha256").update(JSON.stringify(contents), "utf8").digest("hex");
}

function eligibleFeatureCatalog(
  pageCount: number,
  observedBatchSizes: number[] = [],
  featuresFor: (logicalPageId: number) => Record<string, boolean | number | readonly string[]> =
    () => ({ is_open: true, has_captured_content: true }),
): PriorityFeatureCatalog {
  const subjects = Array.from({ length: pageCount }, (_, index) => ({
    type: "page" as const,
    logicalPageId: index + 1,
  }));
  const unused = () => {
    throw new Error("acceptance fake: unused outcome-reading interface");
  };
  return {
    read: unused,
    readBatch: unused,
    reviewQueue: unused,
    listSubjects: () => subjects,
    listSubjectPage(input) {
      const afterId = input.after?.type === "page" ? input.after.logicalPageId : 0;
      const remaining = subjects.filter((subject) => subject.logicalPageId > afterId);
      const items = remaining.slice(0, input.limit);
      return {
        items,
        nextAfter: remaining.length > input.limit ? items.at(-1)! : null,
      };
    },
    previewBatch: (batch) => {
      observedBatchSizes.push(batch.length);
      return batch.map((subject) => ({
        subject,
        features: subject.type === "page" ? featuresFor(subject.logicalPageId) : {},
        eligibility: { kind: "eligible" as const },
        featureFingerprint: "a".repeat(64),
      }));
    },
  };
}

describe("C60b preview independent acceptance", () => {
  it("classifies reason-only changes as unchanged and writes no database row", () => {
    const database = fixture(12);
    try {
      const catalog = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: eligibleFeatureCatalog(12),
      });
      const before = databaseSnapshot(database.connection);
      const result = catalog.preview({
        kind: "structured",
        additions: [{
          ruleKey: "personal.acceptance.zero-delta",
          priority: 500,
          label: "Reason only",
          appliesTo: "page",
          when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
          effect: { scoreDelta: 0 },
        }],
      });
      const after = databaseSnapshot(database.connection);

      expect(result.eligibleCount).toBe(12);
      expect(result.examples).toHaveLength(12);
      expect(new Set(result.examples.map((example) => example.stratum)))
        .toEqual(new Set(["unchanged"]));
      expect(after).toBe(before);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM priority_assessments`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM priority_exclusions`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`)
        .pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("samples the full logical-page corpus by the independent hash oracle in batches of at most 100", () => {
    const database = fixture(205);
    try {
      const batchSizes: number[] = [];
      const catalog = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: eligibleFeatureCatalog(205, batchSizes),
      });
      const before = databaseSnapshot(database.connection);
      const result = catalog.preview({
        kind: "structured",
        additions: [{
          ruleKey: "personal.acceptance.score-change",
          priority: 500,
          label: "Score change",
          appliesTo: "page",
          when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
          effect: { scoreDelta: 1 },
        }],
      });
      const expectedIds = Array.from({ length: 205 }, (_, index) => index + 1)
        .sort((left, right) => {
          const leftHash = createHash("sha256")
            .update(`${result.candidate.astHash}${left}`, "utf8").digest("hex");
          const rightHash = createHash("sha256")
            .update(`${result.candidate.astHash}${right}`, "utf8").digest("hex");
          return leftHash.localeCompare(rightHash) || left - right;
        })
        .slice(0, 20);

      expect(result.scannedCount).toBe(205);
      expect(result.eligibleCount).toBe(205);
      expect(batchSizes).toEqual([100, 100, 5]);
      expect(result.examples.map((example) => example.logicalPageId)).toEqual(expectedIds);
      expect(new Set(result.examples.map((example) => example.stratum)))
        .toEqual(new Set(["assessment_changed"]));
      expect(databaseSnapshot(database.connection)).toBe(before);
    } finally {
      database.close();
    }
  });

  it("applies exact stratum quotas before filling the deterministic deficit", () => {
    const database = fixture(25);
    try {
      const stratumForId = (id: number) => id <= 5
        ? "exclusion_changed" as const
        : id <= 10
          ? "band_changed" as const
          : id <= 15
            ? "assessment_changed" as const
            : "unchanged" as const;
      const statusForId = (id: number) => id <= 5
        ? "archived"
        : id <= 10
          ? "done"
          : id <= 15
            ? "in_progress"
            : "inbox";
      const catalog = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: eligibleFeatureCatalog(25, [], (id) => ({
          status: [statusForId(id)],
          has_captured_content: true,
        })),
      });
      const result = catalog.preview({
        kind: "structured",
        additions: [
          {
            ruleKey: "personal.acceptance.exclude",
            priority: 500,
            label: "Exclude archived",
            appliesTo: "page",
            when: { all: [{ signal: "status", operator: "in", value: ["archived"] }] },
            effect: { exclusionReason: "policy_excluded" },
          },
          {
            ruleKey: "personal.acceptance.band",
            priority: 500,
            label: "Raise done",
            appliesTo: "page",
            when: { all: [{ signal: "status", operator: "in", value: ["done"] }] },
            effect: { scoreDelta: 50 },
          },
          {
            ruleKey: "personal.acceptance.score",
            priority: 500,
            label: "Nudge in progress",
            appliesTo: "page",
            when: { all: [{ signal: "status", operator: "in", value: ["in_progress"] }] },
            effect: { scoreDelta: 1 },
          },
        ],
      });
      const rank = (id: number) => createHash("sha256")
        .update(`${result.candidate.astHash}${id}`, "utf8").digest("hex");
      const hashOrder = Array.from({ length: 25 }, (_, index) => index + 1)
        .sort((left, right) => rank(left).localeCompare(rank(right)) || left - right);
      const precedence = [
        "exclusion_changed",
        "band_changed",
        "assessment_changed",
        "unchanged",
      ] as const;
      const selected = precedence.flatMap((stratum) =>
        hashOrder.filter((id) => stratumForId(id) === stratum).slice(0, 4));
      for (const id of hashOrder) {
        if (selected.length >= 20) break;
        if (!selected.includes(id)) selected.push(id);
      }
      selected.sort((left, right) =>
        precedence.indexOf(stratumForId(left)) - precedence.indexOf(stratumForId(right)) ||
        rank(left).localeCompare(rank(right)) || left - right);

      expect(result.examples.map((example) => ({
        id: example.logicalPageId,
        stratum: example.stratum,
      }))).toEqual(selected.map((id) => ({ id, stratum: stratumForId(id) })));
    } finally {
      database.close();
    }
  });

  it("fails closed instead of returning a partial preview beyond 10,000 pages", () => {
    const database = fixture(0);
    try {
      const batchSizes: number[] = [];
      const catalog = createPersonalPriorityRulesCatalog(database.connection, {
        now: () => now,
        featureCatalog: eligibleFeatureCatalog(10_001, batchSizes),
      });
      const before = databaseSnapshot(database.connection);
      try {
        catalog.preview({ kind: "structured", additions: [] });
        throw new Error("expected preview limit failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PersonalPriorityRulesError);
        expect((error as PersonalPriorityRulesError).code)
          .toBe("PRIORITY_RULE_PREVIEW_LIMIT");
      }
      expect(batchSizes).toHaveLength(100);
      expect(new Set(batchSizes)).toEqual(new Set([100]));
      expect(databaseSnapshot(database.connection)).toBe(before);
    } finally {
      database.close();
    }
  });
});
