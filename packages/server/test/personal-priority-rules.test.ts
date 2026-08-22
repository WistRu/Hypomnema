import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PersonalPriorityLifecycleRequest } from "@tabhub/shared";
import type { PersonalPriorityRule } from "@tabhub/shared";

import { openDatabase } from "../src/database.js";
import {
  baselinePriorityRulesetRef,
  createPersonalPriorityRulesCatalog,
  PersonalPriorityRulesError,
  personalPriorityRequestFingerprint,
} from "../src/personal-priority-rules.js";
import { createPriorityFeatureCatalog } from "../src/priority-feature-catalog.js";

const now = "2026-08-13T10:00:00.000Z";
const rule: PersonalPriorityRule = {
  ruleKey: "personal.test.open",
  priority: 500,
  label: "Open pages",
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
    migrationClock: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  const features = createPriorityFeatureCatalog(database.connection);
  return {
    database,
    rules: createPersonalPriorityRulesCatalog(database.connection, {
      now: () => now,
      writerEnabled,
      featureCatalog: features,
    }),
  };
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

describe("PersonalPriorityRulesCatalog", () => {
  it("saves immutable inactive versions and exact-replays only identical content", () => {
    const f = catalog(":memory:");
    try {
      const request = fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      const first = f.rules.change(request);
      const replay = f.rules.change(request);
      expect(first).toMatchObject({
        operation: "save", changed: true, replayed: false,
        activeRef: baselinePriorityRulesetRef, latestVersion: 1,
      });
      expect(replay).toMatchObject({ changed: false, replayed: true, target: first.target });
      expect(f.database.connection.prepare("SELECT COUNT(*) FROM priority_rule_versions")
        .pluck().get()).toBe(2);

      const divergent = fingerprint({
        ...request,
        draft: { kind: "structured" as const, additions: [{
          ...rule, effect: { scoreDelta: 11 },
        }] },
      });
      expectCode(() => f.rules.change(divergent), "PRIORITY_RULESET_CONFLICT");
      expectCode(() => f.rules.change({ ...request, requestFingerprint: "f".repeat(64) }),
        "PRIORITY_RULESET_CONFLICT");
    } finally { f.database.close(); }
  });

  it("activates, disables, rolls back and resets with pointer/content CAS", () => {
    const f = catalog(":memory:");
    try {
      const saved1 = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      const activate = fingerprint({
        kind: "activate" as const,
        target: saved1.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      expect(f.rules.change(activate)).toMatchObject({
        operation: "activate", changed: true, replayed: false,
        recomputeRequired: true,
      });
      expect(f.rules.change(activate)).toMatchObject({ changed: false, replayed: true });

      const saved2 = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [{
          ...rule, ruleKey: "personal.test.pinned",
          when: { all: [{ signal: "is_pinned" as const, operator: "eq" as const,
            value: true }] },
        }] },
        expectedLatestVersion: 1,
        expectedActiveRef: saved1.target,
      }));
      expectCode(() => f.rules.change(fingerprint({
        kind: "activate" as const,
        target: saved2.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      })), "PRIORITY_RULESET_CONFLICT");

      const rollback = fingerprint({
        kind: "rollback" as const,
        target: saved2.target,
        expectedActiveRef: saved1.target,
      });
      expect(f.rules.change(rollback)).toMatchObject({ activeRef: saved2.target });
      const disable = fingerprint({
        kind: "disable" as const,
        expectedActiveRef: saved2.target,
      });
      expect(f.rules.change(disable)).toMatchObject({ activeRef: baselinePriorityRulesetRef });
      expect(f.rules.change(disable)).toMatchObject({ replayed: true, changed: false });

      const reset = fingerprint({
        kind: "reset" as const,
        expectedLatestVersion: 2,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      const resetResult = f.rules.change(reset);
      expect(resetResult).toMatchObject({ operation: "reset", latestVersion: 3,
        changed: true, replayed: false });
      expect(f.rules.read().versions[0]?.additions).toEqual([]);
      expect(f.rules.change(reset)).toMatchObject({ replayed: true, changed: false });
    } finally { f.database.close(); }
  });

  it("rejects unrelated rulesets and permits draft save but not activation without writer", () => {
    const f = catalog(":memory:", false);
    try {
      f.database.connection.exec(`INSERT INTO priority_rulesets
        (id,name,created_at,updated_at) VALUES (99,'Unrelated','${now}','${now}');
        INSERT INTO priority_rule_versions
        (ruleset_id,version,rule_ast_json,created_by,created_at)
        SELECT 99,1,rule_ast_json,'agent','${now}' FROM priority_rule_versions
        WHERE ruleset_id=1 AND version=1`);
      expectCode(() => f.rules.change(fingerprint({
        kind: "activate" as const,
        target: { rulesetId: 99, version: 1 },
        expectedActiveRef: baselinePriorityRulesetRef,
      })), "PRIORITY_FEATURE_UNAVAILABLE");
      const saved = f.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      expect(saved.changed).toBe(true);
      expectCode(() => f.rules.change(fingerprint({
        kind: "activate" as const,
        target: saved.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      })), "PRIORITY_FEATURE_UNAVAILABLE");
    } finally { f.database.close(); }

    const g = catalog(":memory:", true);
    try {
      g.database.connection.exec(`INSERT INTO priority_rulesets
        (id,name,created_at,updated_at) VALUES (99,'Unrelated','${now}','${now}');
        INSERT INTO priority_rule_versions
        (ruleset_id,version,rule_ast_json,created_by,created_at)
        SELECT 99,1,rule_ast_json,'agent','${now}' FROM priority_rule_versions
        WHERE ruleset_id=1 AND version=1`);
      expectCode(() => g.rules.change(fingerprint({
        kind: "activate" as const,
        target: { rulesetId: 99, version: 1 },
        expectedActiveRef: baselinePriorityRulesetRef,
      })), "PRIORITY_RULESET_VERSION_NOT_FOUND");
    } finally { g.database.close(); }
  });

  it("survives close/reopen and gives one concurrent CAS winner", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-priority-rules-"));
    const path = join(directory, "rules.sqlite");
    try {
      let first = catalog(path);
      const saved = first.rules.change(fingerprint({
        kind: "save" as const,
        draft: { kind: "structured" as const, additions: [rule] },
        expectedLatestVersion: null,
        expectedActiveRef: baselinePriorityRulesetRef,
      }));
      first.database.close();
      first = catalog(path);
      expect(first.rules.read().latestVersion).toBe(1);
      first.database.close();

      const winner = catalog(path);
      const loser = catalog(path);
      const activate = fingerprint({
        kind: "activate" as const,
        target: saved.target,
        expectedActiveRef: baselinePriorityRulesetRef,
      });
      expect(winner.rules.change(activate).changed).toBe(true);
      expect(loser.rules.change(activate)).toMatchObject({ changed: false, replayed: true });
      winner.database.close();
      loser.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
