import { describe, expect, it } from "vitest";

import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { createLiveAcquisitionMaterializer } from "../src/live-acquisition-materializer.js";
import { openDatabase } from "../src/database.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import {
  liveResearchFixtureAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

describe("live acquisition materializer", () => {
  it("admits roots in robots-first order and converges after a crash between actions", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(liveResearchFixtureAt),
      });
      const previewResourceUrl = createResourceCatalog(database.connection,
        () => new Date(liveResearchFixtureAt)).previewResourceUrl;
      let crash = true;
      const crashingLedger = {
        ...ledger,
        planUnknownPage: (input: { consentId: number; url: string }) => {
          if (crash) {
            crash = false;
            throw new Error("injected crash after robots");
          }
          return ledger.planUnknownPage(input);
        },
      };
      const first = createLiveAcquisitionMaterializer(database.connection, {
        actionLedger: crashingLedger,
        previewResourceUrl,
        clock: () => new Date(liveResearchFixtureAt),
      });
      expect(() => first.admitSeedOriginsForClaim(fixture.coordinatorJobId))
        .toThrow("injected crash after robots");
      expect(database.connection.prepare(`
        SELECT action_kind FROM live_acquisition_actions
        WHERE coordinator_run_generation_id = (
          SELECT coordinator_run_generation_id FROM live_acquisition_consents WHERE id = 1
        ) AND id <> 7001 ORDER BY id
      `).all()).toEqual([{ action_kind: "robots" }]);

      const replay = createLiveAcquisitionMaterializer(database.connection, {
        actionLedger: ledger,
        previewResourceUrl,
        clock: () => new Date(liveResearchFixtureAt),
      });
      replay.admitSeedOriginsForClaim(fixture.coordinatorJobId);
      replay.admitSeedOriginsForClaim(fixture.coordinatorJobId);
      const rows = database.connection.prepare(`
        SELECT id, action_kind FROM live_acquisition_actions
        WHERE coordinator_run_generation_id = (
          SELECT coordinator_run_generation_id FROM live_acquisition_consents WHERE id = 1
        ) AND id <> 7001 ORDER BY id
      `).all() as Array<{ id: number; action_kind: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map(({ action_kind }) => action_kind)).toEqual(["robots", "page"]);
      expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM logical_pages
        WHERE url_normalized = 'https://www.cloudflare.com/'
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
