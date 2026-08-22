import { describe, expect, it } from "vitest";

import {
  createResourceCommandCatalog,
  ResourceCommandCatalogError,
} from "../src/resource-command-catalog.js";
import { openDatabase } from "../src/database.js";

const user = { actor: "user", method: "manual" } as const;
const agent = { actor: "agent", method: "on_behalf_of_user" } as const;

describe("ResourceCommandCatalog user evaluation", () => {
  it("separates user/agent provenance, clears coherently, noops, and replays exactly", () => {
    const database = openDatabase(":memory:");
    try {
      let now = "2026-08-12T10:00:00.000Z";
      const catalog = createResourceCommandCatalog(database.connection, () => new Date(now));
      const created = catalog.change({ kind: "create", resourceKey: "platform:evaluation",
        name: "Evaluation", resourceKind: "platform", accessClass: "public",
        provenance: user, idempotencyKey: "create-evaluation" });
      if (created.result.kind !== "create") throw new Error("expected resource");
      const resourceId = created.result.resource.resource.id;
      now = "2026-08-12T10:01:00.000Z";
      const userReceipt = catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 3, provenance: user, idempotencyKey: "evaluation-user" });
      expect(catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 3, provenance: user, idempotencyKey: "evaluation-user" }))
        .toEqual(userReceipt);
      expect(userReceipt.result).toMatchObject({ changed: true, evaluation: 3,
        provenance: user, updatedAt: now });
      expect(() => catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 2, provenance: user, idempotencyKey: "evaluation-user" }))
        .toThrowError(expect.objectContaining<Partial<ResourceCommandCatalogError>>({
          code: "IDEMPOTENCY_KEY_CONFLICT",
        }));
      now = "2026-08-12T10:02:00.000Z";
      expect(catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 3, provenance: agent, idempotencyKey: "evaluation-agent" }).result)
        .toMatchObject({ changed: true, evaluation: 3, provenance: agent, updatedAt: now });
      now = "2026-08-12T10:03:00.000Z";
      const cleared = catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: null, provenance: agent, idempotencyKey: "evaluation-clear" });
      expect(cleared.result).toMatchObject({ changed: true, evaluation: null,
        provenance: null, updatedAt: now });
      now = "2026-08-12T10:04:00.000Z";
      expect(catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: null, provenance: user, idempotencyKey: "evaluation-clear-noop" }).result)
        .toMatchObject({ changed: false, evaluation: null, provenance: null,
          updatedAt: "2026-08-12T10:03:00.000Z" });
      expect(catalog.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 3, provenance: user, idempotencyKey: "evaluation-user" }))
        .toEqual(userReceipt);
      const restarted = createResourceCommandCatalog(database.connection,
        () => new Date("2026-08-12T11:00:00.000Z"));
      expect(restarted.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 3, provenance: user, idempotencyKey: "evaluation-user" }))
        .toEqual(userReceipt);
      expect(() => restarted.change({ kind: "set_user_evaluation", resourceId: 999_999,
        evaluation: 1, provenance: user, idempotencyKey: "missing-evaluation" }))
        .toThrowError(expect.objectContaining<Partial<ResourceCommandCatalogError>>({
          code: "RESOURCE_NOT_FOUND",
        }));
    } finally {
      database.close();
    }
  });

  it("rolls preference back when receipt-last persistence faults", () => {
    const database = openDatabase(":memory:");
    try {
      const base = createResourceCommandCatalog(database.connection,
        () => new Date("2026-08-12T10:00:00.000Z"));
      const created = base.change({ kind: "create", resourceKey: "platform:rollback-eval",
        name: "Rollback", resourceKind: "platform", accessClass: "public",
        provenance: user, idempotencyKey: "create-rollback-eval" });
      if (created.result.kind !== "create") throw new Error("expected resource");
      const resourceId = created.result.resource.resource.id;
      const faulting = createResourceCommandCatalog(database.connection,
        () => new Date("2026-08-12T10:01:00.000Z"), {
          afterResourcePreferenceUpdate() { throw new Error("fault after preference"); },
        });
      expect(() => faulting.change({ kind: "set_user_evaluation", resourceId,
        evaluation: 2, provenance: user, idempotencyKey: "rollback-evaluation" }))
        .toThrow("fault after preference");
      expect(database.connection.prepare(`
        SELECT user_evaluation, recorded_by, record_method
        FROM resource_preferences WHERE resource_id = ?
      `).get(resourceId)).toEqual({
        user_evaluation: null, recorded_by: null, record_method: null,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_command_receipts WHERE idempotency_key = ?
      `).pluck().get("rollback-evaluation")).toBe(0);
    } finally {
      database.close();
    }
  });
});
