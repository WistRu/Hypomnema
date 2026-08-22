import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import type { LocalCapabilityService } from "../src/local-capability.js";
import { createResearchReportCatalog } from "../src/research-report-catalog.js";
import { registerResearchRoutes } from "../src/research-routes.js";

const NOW = "2026-08-14T12:00:00.000Z";
const fingerprint = "1".repeat(64);

describe("research report HTTP corruption boundary", () => {
  it("maps a real catalog storage-corruption error to an opaque 500", async () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(NOW),
    });
    database.connection.exec(`
      INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (
        1, 'https://openai.com/corrupt-report', 'https://openai.com/corrupt-report',
        'https://openai.com/corrupt-report', '${NOW}', '${NOW}'
      );
      INSERT INTO ai_jobs (
        id, kind, subject_type, logical_page_id, subject_key,
        requested_by, request_method, idempotency_key,
        submission_fingerprint, input_fingerprint,
        workflow_id, workflow_version, scheduling_priority,
        available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
        created_at, updated_at
      ) VALUES (
        1, 'resource_research', 'page', 1, 'page:1',
        'user', 'manual', 'corrupt-report-http-job',
        '${fingerprint}', '${fingerprint}',
        'corrupt-report-http', 1, 0,
        '${NOW}', 10, 1000, 1, 60000,
        '${NOW}', '${NOW}'
      );
      INSERT INTO research_runs (
        id, job_id, target_logical_page_id, target_key,
        question_digest, scope_json, approval_fingerprint, corpus_fingerprint,
        submission_fingerprint, workflow_id, workflow_version,
        max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at
      ) VALUES (
        1, 1, 1, 'page:1',
        '${fingerprint}', '{}', '${fingerprint}', '${fingerprint}',
        '${fingerprint}', 'corrupt-report-http', 1,
        10, 1000, 1, 60000, '${NOW}'
      );
      INSERT INTO research_reports (
        id, run_id, target_logical_page_id, target_key, version,
        publish_status, coverage_json, coverage_fingerprint,
        provenance_json, input_fingerprint, created_at
      ) VALUES (
        1, 1, 1, 'page:1', 1,
        'succeeded',
        '{"captured":0,"discovered":0,"eligible":0,"failed":0,"missing":0,"used":0}',
        '${fingerprint}', '{}', '${fingerprint}', '${NOW}'
      );
    `);

    const app = Fastify();
    const capabilities = {
      authenticate(request) {
        return request.headers.authorization === "Bearer local"
          ? { kind: "web" as const, installationId: null }
          : null;
      },
    } as LocalCapabilityService;
    registerResearchRoutes(app, {
      capabilities,
      researchEnabled: false,
      workflow: {
        preflight: () => { throw new Error("not used"); },
        requestRun: () => { throw new Error("not used"); },
        redact: () => { throw new Error("not used"); },
      },
      reports: createResearchReportCatalog(database.connection),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/research/reports/1",
        headers: { authorization: "Bearer local" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(response.body).not.toContain("corrupt-report");
      expect(response.body).not.toContain("Research report storage is corrupt");
    } finally {
      await app.close();
      database.close();
    }
  });
});
