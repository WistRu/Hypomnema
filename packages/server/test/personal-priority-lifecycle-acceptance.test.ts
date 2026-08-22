import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type {
  PersonalPriorityLifecycleRequest,
  PersonalPriorityRule,
} from "@tabhub/shared";

import { openDatabase } from "../src/database.js";
import {
  baselinePriorityRulesetRef,
  createPersonalPriorityRulesCatalog,
  PersonalPriorityRulesError,
  personalPriorityRequestFingerprint,
} from "../src/personal-priority-rules.js";
import { createPriorityEngine } from "../src/priority-engine.js";
import { createPriorityFeatureCatalog } from "../src/priority-feature-catalog.js";
import { createResourceCommandCatalog } from "../src/resource-command-catalog.js";

const now = "2026-08-13T10:30:00.000Z";
const rule: PersonalPriorityRule = {
  ruleKey: "personal.acceptance.lifecycle",
  priority: 500,
  label: "Lifecycle acceptance",
  appliesTo: "page",
  when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
  effect: { scoreDelta: 10 },
};

type LifecyclePayload = PersonalPriorityLifecycleRequest extends infer Request
  ? Request extends { requestFingerprint: string }
    ? Omit<Request, "requestFingerprint">
    : never
  : never;

function fingerprint<T extends LifecyclePayload>(value: T): T & { requestFingerprint: string } {
  return { ...value, requestFingerprint: personalPriorityRequestFingerprint(value) };
}

function catalog(path: string, writerEnabled = true) {
  const database = openDatabase(path, {
    migrationClock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const features = createPriorityFeatureCatalog(database.connection);
  return {
    database,
    features,
    rules: createPersonalPriorityRulesCatalog(database.connection, {
      now: () => now,
      writerEnabled,
      featureCatalog: features,
    }),
  };
}

function nonRulesState(connection: ReturnType<typeof catalog>["database"]["connection"]): string {
  const excluded = new Set([
    "priority_rulesets",
    "priority_rule_versions",
    "priority_ruleset_activations",
  ]);
  const names = connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[];
  return JSON.stringify(names.filter((name) => !excluded.has(name)).map((name) => ({
    name,
    rows: connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
  })));
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonalPriorityRulesError);
    expect((error as PersonalPriorityRulesError).code).toBe(code);
  }
}

function assessCurrentSubjects(
  f: ReturnType<typeof catalog>,
  subjects = f.features.listSubjects(),
) {
  const projections = f.features.previewBatch(subjects, now);
  const outcomes = createPriorityEngine(f.database.connection, { now: () => now }).assess(
    projections.map((projection) => ({
      subject: projection.subject,
      features: projection.features,
      eligibility: projection.eligibility,
      assessmentMethod: "rule" as const,
    })),
  );
  return { projections, outcomes };
}

describe("C60b lifecycle independent acceptance", () => {
  it("changes only ruleset content/pointer and makes existing outcomes stale without recomputing", () => {
    const f = catalog(":memory:");
    try {
      f.database.connection.exec(`
        INSERT INTO logical_pages (
          id,identity_key,url_normalized,representative_url,created_at,updated_at
        ) VALUES (
          1,'https://lifecycle.test/1','https://lifecycle.test/1',
          'https://lifecycle.test/1','${now}','${now}'
        );
        INSERT INTO logical_page_preferences (
          logical_page_id,user_importance,recorded_by,record_method,
          importance_updated_at,updated_at
        ) VALUES (1,3,'user','manual','${now}','${now}');
      `);
      createPriorityEngine(f.database.connection, { now: () => now }).assess([{
        subject: { type: "page", logicalPageId: 1 },
        features: { is_open: true, has_captured_content: true },
        assessmentMethod: "rule",
      }]);
      const protectedBefore = nonRulesState(f.database.connection);

      const saved = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      expect(saved).toMatchObject({ changed: true, activeRef: baselinePriorityRulesetRef });
      expect(nonRulesState(f.database.connection)).toBe(protectedBefore);

      const activated = f.rules.change(fingerprint({
        kind: "activate" as const,
        target: saved.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      expect(activated).toMatchObject({
        changed: true,
        recomputeRequired: true,
        staleOutcomeCount: 1,
      });
      expect(nonRulesState(f.database.connection)).toBe(protectedBefore);
      expect(f.database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);
      expect(f.database.connection.prepare(`SELECT created_by FROM priority_rule_versions
        WHERE ruleset_id=? AND version=?`).pluck().get(
        saved.target.rulesetId,
        saved.target.version,
      )).toBe("user");
    } finally {
      f.database.close();
    }
  });

  it("rolls reset content and pointer back together when the pointer write fails", () => {
    const f = catalog(":memory:");
    try {
      const saved = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      f.rules.change(fingerprint({
        kind: "activate" as const,
        target: saved.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      const versionsBefore = f.database.connection.prepare(`SELECT *
        FROM priority_rule_versions ORDER BY ruleset_id,version`).all();
      const pointerBefore = f.database.connection.prepare(`SELECT *
        FROM priority_ruleset_activations`).all();
      f.database.connection.exec(`CREATE TEMP TRIGGER acceptance_fail_pointer
        BEFORE UPDATE ON main.priority_ruleset_activations
        BEGIN SELECT RAISE(ABORT, 'acceptance injected pointer failure'); END`);
      const reset = fingerprint({
        kind: "reset" as const,
        expectedLatestVersion: 1,
        expectedActiveRef: saved.target,
      });
      expect(() => f.rules.change(reset)).toThrow(/acceptance injected pointer failure/);
      expect(f.database.connection.prepare(`SELECT * FROM priority_rule_versions
        ORDER BY ruleset_id,version`).all()).toEqual(versionsBefore);
      expect(f.database.connection.prepare(`SELECT * FROM priority_ruleset_activations`).all())
        .toEqual(pointerBefore);
      f.database.connection.exec("DROP TRIGGER acceptance_fail_pointer");

      const result = f.rules.change(reset);
      expect(result).toMatchObject({ changed: true, replayed: false, latestVersion: 2 });
      expect(f.rules.change(reset)).toMatchObject({ changed: false, replayed: true });
    } finally {
      f.database.close();
    }
  });

  it("gives one divergent save winner across connections and exact-replays after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-c60b-acceptance-"));
    const path = join(directory, "rules.sqlite");
    try {
      const winner = catalog(path);
      const loser = catalog(path);
      const winningRequest = fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      const losingRequest = fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [{
          ...rule,
          effect: { scoreDelta: 11 },
        }] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      const saved = winner.rules.change(winningRequest);
      expectCode(() => loser.rules.change(losingRequest), "PRIORITY_RULESET_CONFLICT");
      expect(winner.database.connection.prepare(`SELECT COUNT(*) FROM priority_rulesets
        WHERE name='Personal priority rules'`).pluck().get()).toBe(1);
      expect(winner.database.connection.prepare(`SELECT COUNT(*) FROM priority_rule_versions
        WHERE ruleset_id=?`).pluck().get(saved.target.rulesetId)).toBe(1);
      winner.database.close();
      loser.database.close();

      const reopened = catalog(path);
      try {
        expect(reopened.rules.change(winningRequest)).toMatchObject({
          target: saved.target,
          changed: false,
          replayed: true,
        });
      } finally {
        reopened.database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps recompute required after activation when eligible pages have no prior outcome", () => {
    const f = catalog(":memory:");
    try {
      f.database.connection.exec(`INSERT INTO logical_pages (
        id,identity_key,url_normalized,representative_url,created_at,updated_at
      ) VALUES (
        1,'https://missing-outcome.test/1','https://missing-outcome.test/1',
        'https://missing-outcome.test/1','${now}','${now}'
      )`);
      const saved = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      expect(f.rules.change(fingerprint({
        kind: "activate" as const,
        target: saved.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      })).recomputeRequired).toBe(true);
      expect(f.rules.read().recomputeRequired).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it("detects a stale feature fingerprint while the active ruleset stays unchanged", () => {
    const f = catalog(":memory:");
    try {
      f.database.connection.exec(`
        INSERT INTO logical_pages (
          id,identity_key,url_normalized,representative_url,created_at,updated_at
        ) VALUES (
          1,'https://feature-stale.test/1','https://feature-stale.test/1',
          'https://feature-stale.test/1','${now}','${now}'
        );
        INSERT INTO tabs (
          id,url,url_normalized,title,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id
        ) VALUES (
          1,'https://feature-stale.test/1','https://feature-stale.test/1',
          'Feature stale','chrome','inbox',0,1,'${now}','${now}',1
        );
      `);
      const subject = { type: "page" as const, logicalPageId: 1 };
      const subjects = f.features.listSubjects();
      expect(subjects).toContainEqual(subject);
      const { projections, outcomes } = assessCurrentSubjects(f, subjects);
      const projection = projections.find((candidate) =>
        candidate.subject.type === "page" && candidate.subject.logicalPageId === 1)!;
      const outcome = outcomes[projections.indexOf(projection)]!;
      const value = outcome!.kind === "assessment" ? outcome!.assessment : outcome!.exclusion;
      expect(value.featureFingerprint).toBe(projection.featureFingerprint);
      expect(f.features.readBatch([subject], now)[0]).toMatchObject({
        featureFingerprint: projection.featureFingerprint,
        dirty: false,
        isCurrent: true,
      });
      expect(f.rules.read().recomputeRequired).toBe(false);

      f.database.connection.prepare("UPDATE tabs SET is_open=0 WHERE id=1").run();
      expect(f.rules.read().recomputeRequired).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it("treats an active Resource without an outcome as dirty and a matching outcome as current", () => {
    const f = catalog(":memory:");
    try {
      assessCurrentSubjects(f);
      expect(f.rules.read().recomputeRequired).toBe(false);
      const resources = createResourceCommandCatalog(
        f.database.connection,
        () => new Date(now),
      );
      const created = resources.change({
        kind: "create",
        resourceKey: "platform:c60b-acceptance",
        name: "C60b acceptance",
        resourceKind: "platform",
        accessClass: "public",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "c60b-acceptance-resource",
      });
      if (created.result.kind !== "create") throw new Error("expected Resource create");
      const subject = {
        type: "resource" as const,
        resourceId: created.result.resource.resource.id,
      };
      expect(f.features.listSubjects()).toContainEqual(subject);
      expect(f.rules.read().recomputeRequired).toBe(true);

      const projection = f.features.previewBatch([subject], now)[0]!;
      const [outcome] = createPriorityEngine(f.database.connection, { now: () => now }).assess([{
        subject,
        features: projection.features,
        eligibility: projection.eligibility,
        assessmentMethod: "rule",
      }]);
      const value = outcome!.kind === "assessment" ? outcome!.assessment : outcome!.exclusion;
      expect(value.featureFingerprint).toBe(projection.featureFingerprint);
      expect(f.features.readBatch([subject], now)[0]).toMatchObject({
        featureFingerprint: projection.featureFingerprint,
        dirty: false,
        isCurrent: true,
      });
      expect(f.rules.read().recomputeRequired).toBe(false);
    } finally {
      f.database.close();
    }
  });
});
