import { createHash } from "node:crypto";

import { sqlJsonObjectMirrorV1 } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { privacyPurgeBudgetCarryoverPayloadDigest } from "../src/privacy-purge-budget-carryover.js";
import { privacyPurgeCarryoverManifestFromRows } from "../src/privacy-purge-intent-capabilities.js";

/**
 * These bytes are already persisted. The point of pinning them is that routing
 * the digests through the shared SQL byte mirror must be a no-op for every
 * value shape that actually occurs — if it is not, stored digests silently stop
 * matching the ones the database rebuilds, and nothing would say so.
 *
 * Captured from the hand-rolled implementations before they were replaced.
 */
const frozenRow = {
  // `version` first, exactly as privacy-purge-budget-carryover.ts builds it.
  // An earlier draft of this test omitted it and pinned bytes for a shape that
  // never occurs — a proof of the wrong thing, which is worse than no proof.
  version: "privacy_purge_budget_carryover:v1",
  intentKey: "intent-key-1",
  utcDate: "2026-08-20",
  budgetClass: "c90_coordinator",
  jobKind: "resource_research",
  workflowId: "wf-1",
  workflowVersion: 1,
  coordinatorStarts: 3,
  providerAttempts: 0,
  chargedCostNanos: 0,
  activeExposureNanos: 0,
  legacy25DayBlock: 0,
  state: "frozen",
  frozenAt: "2026-08-20T00:00:00.000Z",
  activatedAt: null,
} as const;

const PINNED_PAYLOAD_DIGEST =
  "960e092fa76e3bd5afb555b61589c5a9a39c9f776cef3a3184e0c6932c5549cc";
const PINNED_MANIFEST_DIGEST =
  "41d6c6e525ba358b3abaadcd860b22b4307e83a8d2db8f6db883f94a9073bf5f";

/** The manifest bytes for an exact row order, built the way the digest is. */
function sha256OfRows(
  rows: ReadonlyArray<{ readonly workflowVersion: number; readonly payloadDigest: string }>,
): string {
  return createHash("sha256").update(sqlJsonObjectMirrorV1(rows.map((row) => ({
    intentKey: frozenRow.intentKey,
    utcDate: frozenRow.utcDate,
    budgetClass: frozenRow.budgetClass,
    jobKind: frozenRow.jobKind,
    workflowId: frozenRow.workflowId,
    workflowVersion: row.workflowVersion,
    coordinatorStarts: frozenRow.coordinatorStarts,
    providerAttempts: frozenRow.providerAttempts,
    chargedCostNanos: frozenRow.chargedCostNanos,
    activeExposureNanos: frozenRow.activeExposureNanos,
    legacy25DayBlock: frozenRow.legacy25DayBlock,
    payloadDigest: row.payloadDigest,
    frozenAt: frozenRow.frozenAt,
  }))), "utf8").digest("hex");
}

describe("privacy purge carryover digests keep their persisted bytes", () => {
  it("produces the per-day payload digest that is already stored", () => {
    expect(privacyPurgeBudgetCarryoverPayloadDigest(frozenRow))
      .toBe(PINNED_PAYLOAD_DIGEST);
  });

  it("produces the manifest digest the database rebuilds from those rows", () => {
    expect(privacyPurgeCarryoverManifestFromRows([{
      intentKey: frozenRow.intentKey,
      utcDate: frozenRow.utcDate,
      budgetClass: frozenRow.budgetClass,
      jobKind: frozenRow.jobKind,
      workflowId: frozenRow.workflowId,
      workflowVersion: frozenRow.workflowVersion,
      coordinatorStarts: frozenRow.coordinatorStarts,
      providerAttempts: frozenRow.providerAttempts,
      chargedCostNanos: frozenRow.chargedCostNanos,
      activeExposureNanos: frozenRow.activeExposureNanos,
      legacy25DayBlock: frozenRow.legacy25DayBlock,
      state: "frozen",
      payloadDigest: PINNED_PAYLOAD_DIGEST,
      frozenAt: frozenRow.frozenAt,
      activatedAt: null,
    }])).toEqual({ count: 1, digest: PINNED_MANIFEST_DIGEST });
  });

  it("keeps key order, because the database builds these bytes in column order", () => {
    // Sorting would put activeExposureNanos first and version last, breaking
    // every stored digest. This is why the SQL mirror is the right helper here
    // and canonicalJsonV1, which sorts, is not.
    const digest = privacyPurgeBudgetCarryoverPayloadDigest({
      ...frozenRow,
    });
    expect(digest).toBe(PINNED_PAYLOAD_DIGEST);
  });

  it.each([
    ["a nested undefined", { ...frozenRow, workflowId: undefined },
      "Cannot mirror undefined at $.workflowId"],
    ["a non-finite number", { ...frozenRow, coordinatorStarts: Number.NaN },
      "Cannot mirror non-finite number at $.coordinatorStarts"],
    ["an infinity", { ...frozenRow, chargedCostNanos: Number.POSITIVE_INFINITY },
      "Cannot mirror non-finite number at $.chargedCostNanos"],
    ["a bigint", { ...frozenRow, activeExposureNanos: 1n },
      "Cannot mirror bigint (convert it to the exact SQL rendering first) at $.activeExposureNanos"],
  ])("refuses %s rather than silently altering the bytes", (_label, value, message) => {
    // The message and the path matter, not merely that something threw: a raw
    // JSON.stringify accepts all four and quietly writes different bytes, so a
    // bare toThrow() would also pass on an unrelated TypeError.
    expect(() => privacyPurgeBudgetCarryoverPayloadDigest(
      value as Readonly<Record<string, unknown>>,
    )).toThrowError(message as string);
  });

  it("refuses the same values inside the manifest, at the offending row", () => {
    expect(() => privacyPurgeCarryoverManifestFromRows([{
      intentKey: frozenRow.intentKey,
      utcDate: frozenRow.utcDate,
      budgetClass: frozenRow.budgetClass,
      jobKind: frozenRow.jobKind,
      workflowId: frozenRow.workflowId,
      workflowVersion: frozenRow.workflowVersion,
      coordinatorStarts: Number.NaN,
      providerAttempts: frozenRow.providerAttempts,
      chargedCostNanos: frozenRow.chargedCostNanos,
      activeExposureNanos: frozenRow.activeExposureNanos,
      legacy25DayBlock: frozenRow.legacy25DayBlock,
      state: "frozen",
      payloadDigest: PINNED_PAYLOAD_DIGEST,
      frozenAt: frozenRow.frozenAt,
      activatedAt: null,
    }])).toThrowError("Cannot mirror non-finite number at $[0].coordinatorStarts");
  });
  it("orders workflow versions the way SQLite does, not the way text does", () => {
    // SQL orders workflow_version as an INTEGER. Comparing it as text puts 10
    // before 2, reordering the rows the digest is built from — the manifest
    // would stop matching and nothing would say why. Latent while every row is
    // version 1, which is exactly why it needs a test rather than a comment.
    const row = (workflowVersion: number, payloadDigest: string) => ({
      intentKey: frozenRow.intentKey,
      utcDate: frozenRow.utcDate,
      budgetClass: frozenRow.budgetClass,
      jobKind: frozenRow.jobKind,
      workflowId: frozenRow.workflowId,
      workflowVersion,
      coordinatorStarts: frozenRow.coordinatorStarts,
      providerAttempts: frozenRow.providerAttempts,
      chargedCostNanos: frozenRow.chargedCostNanos,
      activeExposureNanos: frozenRow.activeExposureNanos,
      legacy25DayBlock: frozenRow.legacy25DayBlock,
      state: "frozen" as const,
      payloadDigest,
      frozenAt: frozenRow.frozenAt,
      activatedAt: null,
    });
    // Distinct payload digests, so row order genuinely changes the bytes.
    const two = row(2, "2".repeat(64));
    const ten = row(10, "a".repeat(64));

    // Input order must not matter: both must sort to 2 then 10.
    const fromTenFirst = privacyPurgeCarryoverManifestFromRows([ten, two]).digest;
    const fromTwoFirst = privacyPurgeCarryoverManifestFromRows([two, ten]).digest;
    expect(fromTenFirst).toBe(fromTwoFirst);

    // And the surviving order is the numeric one. Under text comparison the
    // rows would settle as 10 then 2, which is a different digest.
    const numericOrder = sha256OfRows([two, ten]);
    const textOrder = sha256OfRows([ten, two]);
    expect(numericOrder).not.toBe(textOrder);
    expect(fromTwoFirst).toBe(numericOrder);
  });
});
