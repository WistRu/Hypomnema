import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createApp } from "../../server/src/app.js";
import { personalAttentionFeatureFlagsOff } from
  "../../server/src/attention-feature-flags.js";
import { openDatabase } from "../../server/src/database.js";
import type { ResearchProvider } from "../../server/src/research-provider.js";
import { createMcpServer } from "../src/server.js";
import { createTabHubApi } from "../src/tabhub-api.js";

const now = "2026-08-14T10:00:00.000Z";

function pendingResearchProvider(): ResearchProvider {
  return {
    metadata: {
      provider: "anthropic",
      model: "fixture-model",
      promptVersion: "fixture-v1",
      pricingVersion: "fixture-pricing-v1",
    },
    quote: () => ({
      version: "research_provider_quote:v1",
      inputDigest: "1".repeat(64),
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      wallTimeMs: 1,
    }),
    async start(_input, _quote, signal) {
      return {
        requestId: "fixture-real-adapter-request",
        read: () => new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("Fixture research provider aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      };
    },
  };
}

async function connectResearchMcp(baseUrl: string) {
  const server = createMcpServer(createTabHubApi({ baseUrl }), {
    features: { context: false, logicalImportance: false, research: true },
  });
  const client = new Client({ name: "research-real-adapter", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected a text MCP result");
  return block.text;
}

describe("TabHub real research REST adapter", () => {
  it("confirms, starts, then replays the original job after corpus drift without process cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-mcp-research-adapter-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({
      databasePath,
      logger: false,
      localDevProxySecret: "research-real-adapter-secret",
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        resources: true,
        research: true,
      },
      researchProvider: pendingResearchProvider(),
      clock: () => new Date(now),
      migrationClock: () => new Date(now),
    });
    const database = openDatabase(databasePath);
    let firstConnection: Awaited<ReturnType<typeof connectResearchMcp>> | undefined;
    let replayConnection: Awaited<ReturnType<typeof connectResearchMcp>> | undefined;
    try {
      const url = "https://openai.com/research-adapter";
      const logicalPageId = Number(database.connection.prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(url, url, url, now, now).lastInsertRowid);
      const tabId = Number(database.connection.prepare(`
        INSERT INTO tabs (
          url, url_normalized, title, browser, status, importance, is_open,
          first_seen_at, last_seen_at, logical_page_id
        ) VALUES (?, ?, 'Research adapter fixture', 'chrome', 'inbox', 0, 1, ?, ?, ?)
      `).run(url, url, now, now, logicalPageId).lastInsertRowid);
      database.connection.prepare(`
        INSERT INTO contents (tab_id, text, extracted_at, content_revision)
        VALUES (?, 'Captured evidence', ?, 1)
      `).run(tabId, now);
      const resourceId = Number(database.connection.prepare(`
        INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
      `).run("custom:mcp-real-adapter", now).lastInsertRowid);
      const firstResourceEventId = Number(database.connection.prepare(`
        INSERT INTO resource_events (
          resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (?, 1, 'MCP real adapter', 'website', 'authenticated', 'active',
          'user', 'manual', ?)
      `).run(resourceId, now).lastInsertRowid);
      database.connection.prepare(`
        INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
      `).run(resourceId, firstResourceEventId);
      const assignmentId = Number(database.connection.prepare(`
        INSERT INTO logical_page_resource_assignments (
          logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
      `).run(
        logicalPageId,
        resourceId,
        `mcp-real-adapter:${logicalPageId}:${resourceId}`,
        now,
      ).lastInsertRowid);
      database.connection.prepare(`
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (?, ?)
      `).run(logicalPageId, assignmentId);

      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      firstConnection = await connectResearchMcp(origin);
      const baseInput = {
        target: { type: "resource" as const, resource_id: resourceId },
        question: "What is useful for this project?",
        include_shareable_context: false,
        max_included_sources: 25,
        budget: {
          max_steps: 4,
          max_tokens: 8_000,
          max_cost_usd: 0.5,
          max_wall_time_ms: 30_000,
        },
        idempotency_key: "mcp-real-adapter-replay",
        authorization_ref: "user-instruction:mcp-real-adapter-replay",
      };

      const confirmationResult = await firstConnection.client.callTool({
        name: "start_research",
        arguments: baseInput,
      });
      const confirmation = JSON.parse(textResult(confirmationResult)) as {
        status: "confirmation_required";
        confirmationRequirements: {
          authenticatedOriginDigests: string[];
          sensitiveOriginDigests: string[];
        };
      };
      expect(confirmation).toMatchObject({ status: "confirmation_required" });
      expect(confirmation.confirmationRequirements.authenticatedOriginDigests)
        .toHaveLength(1);
      expect({
        jobs: database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get(),
        runs: database.connection.prepare("SELECT COUNT(*) FROM research_runs").pluck().get(),
        receipts: database.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get(),
      }).toEqual({ jobs: 0, runs: 0, receipts: 0 });

      const approvedInput = {
        ...baseInput,
        confirmed_origins: {
          authenticated_origin_digests:
            confirmation.confirmationRequirements.authenticatedOriginDigests,
          sensitive_origin_digests:
            confirmation.confirmationRequirements.sensitiveOriginDigests,
        },
      };
      const firstResult = await firstConnection.client.callTool({
        name: "start_research",
        arguments: approvedInput,
      });
      const first = JSON.parse(textResult(firstResult)) as {
        id: string;
        kind: "resource_research";
        status: string;
      };
      expect(first).toMatchObject({ kind: "resource_research" });

      const sensitiveResourceEventId = Number(database.connection.prepare(`
        INSERT INTO resource_events (
          resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, supersedes_id, created_at
        ) VALUES (?, 2, 'MCP real adapter', 'website', 'sensitive', 'active',
          'user', 'manual', ?, ?)
      `).run(resourceId, firstResourceEventId, now).lastInsertRowid);
      database.connection.prepare(`
        UPDATE resource_heads SET event_id = ? WHERE resource_id = ?
      `).run(sensitiveResourceEventId, resourceId);

      const countsBeforeReplay = {
        jobs: database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get(),
        runs: database.connection.prepare("SELECT COUNT(*) FROM research_runs").pluck().get(),
        receipts: database.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get(),
      };
      await firstConnection.close();
      firstConnection = undefined;
      replayConnection = await connectResearchMcp(origin);
      const replayResult = await replayConnection.client.callTool({
        name: "start_research",
        arguments: approvedInput,
      });
      const replay = JSON.parse(textResult(replayResult)) as {
        id: string;
        kind: "resource_research";
        status: string;
      };
      expect(replay.id).toBe(first.id);
      expect({
        jobs: database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get(),
        runs: database.connection.prepare("SELECT COUNT(*) FROM research_runs").pluck().get(),
        receipts: database.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get(),
      }).toEqual(countsBeforeReplay);
    } finally {
      await firstConnection?.close();
      await replayConnection?.close();
      database.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
