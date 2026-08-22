import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { AiJobClaim } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createLiveAcquisitionHandoff } from "../src/live-acquisition-handoff.js";
import {
  liveResearchFixtureAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

describe("live acquisition immutable handoff", () => {
  it("keeps precompute transaction-free and each terminal path on one immediate transaction", () => {
    const source = readFileSync(new URL("../src/live-acquisition-handoff.ts", import.meta.url),
      "utf8");
    const precompute = source.slice(source.indexOf("function precompute"),
      source.indexOf("function commit"));
    expect(precompute).not.toMatch(/BEGIN|COMMIT|ROLLBACK/);
    const commit = source.slice(source.indexOf("function commit"),
      source.indexOf("function completeNoSource"));
    const noSource = source.slice(source.indexOf("function completeNoSource"),
      source.indexOf("return {\n    completeClaim"));
    for (const terminalPath of [commit, noSource]) {
      expect(terminalPath.match(/BEGIN IMMEDIATE/g)).toHaveLength(1);
      expect(terminalPath).not.toContain("BEGIN DEFERRED");
    }
    const transactionalCommit = commit.slice(commit.indexOf('connection.exec("BEGIN IMMEDIATE")'));
    expect(transactionalCommit).not.toMatch(/options\.(provider|clock|fault)/);
  });

  it("replays the immutable terminal receipt before consulting provider state", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const quote = vi.fn(() => { throw new Error("provider must not run on replay"); });
      const handoff = createLiveAcquisitionHandoff(database.connection, {
        provider: {
          metadata: { provider: "anthropic", model: "fixture",
            promptVersion: "p1", pricingVersion: "price1" },
          quote,
          async start() { throw new Error("provider start must remain closed"); },
        },
        clock: () => new Date(liveResearchFixtureAt),
      });
      const before = database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_handoffs) AS handoffs,
          (SELECT COUNT(*) FROM live_acquisition_handoff_receipts) AS terminals,
          (SELECT COUNT(*) FROM research_sources WHERE run_id=?) AS sources,
          (SELECT COUNT(*) FROM live_acquisition_provider_reservations) AS reservations
      `).get(fixture.finalRunId);
      expect(handoff.completeClaim({ id: fixture.coordinatorJobId } as AiJobClaim))
        .toEqual({ kind: "handoff", finalJobId: fixture.finalJobId });
      expect(quote).not.toHaveBeenCalled();
      expect(database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_handoffs) AS handoffs,
          (SELECT COUNT(*) FROM live_acquisition_handoff_receipts) AS terminals,
          (SELECT COUNT(*) FROM research_sources WHERE run_id=?) AS sources,
          (SELECT COUNT(*) FROM live_acquisition_provider_reservations) AS reservations
      `).get(fixture.finalRunId)).toEqual(before);
    } finally {
      database.close();
    }
  });
});
