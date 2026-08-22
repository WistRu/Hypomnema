import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  PersonalPriorityLifecycleRequest,
  PersonalPriorityRule,
} from "@tabhub/shared";

import { createApp, type TabHubApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";
import { openDatabase } from "../src/database.js";
import {
  baselinePriorityRulesetRef,
  personalPriorityRequestFingerprint,
} from "../src/personal-priority-rules.js";

const cleanup: string[] = [];
const running: TabHubApp[] = [];
const secret = "c60b-acceptance-local-session";

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function fixture(writerEnabled: boolean, personalization = true) {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-c60b-routes-"));
  cleanup.push(directory);
  const databasePath = join(directory, "tabhub.sqlite");
  const options = {
    logger: false,
    localDevProxySecret: secret,
    featureFlags: {
      ...personalAttentionFeatureFlagsOff,
      priorityReaders: true,
      priorityPersonalization: personalization,
      priorityAssessmentWriter: writerEnabled,
    },
  } as const;
  // A memory-only construction canary prevents a constructor failure from
  // leaking a locked temporary file on Windows. The real fixture follows only
  // after the complete app graph can be built and closed.
  const canary = createApp({ ...options, databasePath: ":memory:" });
  await canary.close();
  const app = createApp({ ...options, databasePath });
  running.push(app);
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": secret },
  });
  const cookie = bootstrap.statusCode === 204
    ? String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!
    : "";
  return {
    app,
    databasePath,
    headers: { cookie, "sec-fetch-site": "same-origin" },
  };
}

type LifecyclePayload = PersonalPriorityLifecycleRequest extends infer Request
  ? Request extends { requestFingerprint: string }
    ? Omit<Request, "requestFingerprint">
    : never
  : never;

function fingerprint<T extends LifecyclePayload>(value: T): T & { requestFingerprint: string } {
  return { ...value, requestFingerprint: personalPriorityRequestFingerprint(value) };
}

const rule: PersonalPriorityRule = {
  ruleKey: "personal.acceptance.route",
  priority: 500,
  label: "Route acceptance",
  appliesTo: "page",
  when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
  effect: { scoreDelta: 5 },
};

describe("C60b route capability independent acceptance", () => {
  it("keeps personalization routes and writes absent when the feature is off", async () => {
    const f = await fixture(false, false);
    expect((await f.app.inject({ method: "GET", url: "/api/features" })).json())
      .toMatchObject({ priorityPersonalization: false });
    expect((await f.app.inject({ method: "GET", url: "/api/personalization/rules" }))
      .statusCode).toBe(404);

    await f.app.close();
    running.splice(running.indexOf(f.app), 1);
    const database = openDatabase(f.databasePath);
    try {
      expect(database.connection.prepare(`SELECT COUNT(*) FROM priority_rulesets
        WHERE name='Personal priority rules'`).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("allows local preview/save but rejects unauthenticated, agent and writer-only mutations", async () => {
    const f = await fixture(false);
    expect((await f.app.inject({ method: "GET", url: "/api/personalization/rules" }))
      .statusCode).toBe(401);
    expect((await f.app.inject({
      method: "GET",
      url: "/api/agent/personalization/rules",
      headers: f.headers,
    })).statusCode).toBe(404);
    expect((await f.app.inject({
      method: "POST",
      url: "/api/personalization/rules/preview",
      headers: f.headers,
      payload: { draft: { kind: "structured", additions: [rule] } },
    })).statusCode).toBe(200);

    const saveRequest = fingerprint({
      kind: "save" as const,
      draft: { kind: "structured" as const, additions: [rule] },
      expectedLatestVersion: null,
      expectedActiveRef: baselinePriorityRulesetRef,
    });
    const save = await f.app.inject({
      method: "POST",
      url: "/api/personalization/rules/versions",
      headers: f.headers,
      payload: saveRequest,
    });
    expect(save.statusCode).toBe(200);
    const activate = await f.app.inject({
      method: "POST",
      url: "/api/personalization/rules/activate",
      headers: f.headers,
      payload: fingerprint({
        kind: "activate" as const,
        target: save.json().target,
        expectedActiveRef: baselinePriorityRulesetRef,
      }),
    });
    expect(activate.statusCode).toBe(404);
    expect(activate.json()).toMatchObject({ error: "PRIORITY_FEATURE_UNAVAILABLE" });

    await f.app.close();
    running.splice(running.indexOf(f.app), 1);
    const database = openDatabase(f.databasePath);
    try {
      expect(database.connection.prepare(`SELECT created_by FROM priority_rule_versions
        WHERE ruleset_id<>1`).pluck().get()).toBe("user");
      expect(database.connection.prepare(`SELECT ruleset_id,version
        FROM priority_ruleset_activations WHERE scope='global'`).get())
        .toEqual({ ruleset_id: 1, version: 1 });
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);
    } finally {
      database.close();
    }
  });

  it("activates with writer enabled but never auto-submits a recompute job", async () => {
    const f = await fixture(true);
    const saveRequest = fingerprint({
      kind: "save" as const,
      draft: { kind: "structured" as const, additions: [rule] },
      expectedLatestVersion: null,
      expectedActiveRef: baselinePriorityRulesetRef,
    });
    const save = await f.app.inject({
      method: "POST",
      url: "/api/personalization/rules/versions",
      headers: f.headers,
      payload: saveRequest,
    });
    expect(save.statusCode).toBe(200);
    const activate = await f.app.inject({
      method: "POST",
      url: "/api/personalization/rules/activate",
      headers: f.headers,
      payload: fingerprint({
        kind: "activate" as const,
        target: save.json().target,
        expectedActiveRef: baselinePriorityRulesetRef,
      }),
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({
      changed: true,
      recomputeRequired: true,
    });

    await f.app.close();
    running.splice(running.indexOf(f.app), 1);
    const database = openDatabase(f.databasePath);
    try {
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);
    } finally {
      database.close();
    }
  });
});
