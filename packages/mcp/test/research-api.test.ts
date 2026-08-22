import { describe, expect, it, vi } from "vitest";

import { createTabHubApi } from "../src/tabhub-api.js";
import {
  agentResearchReportDetail,
  cancelledResearchJob,
  confirmationRequired,
  privateResearchCanaries,
  queuedResearchJob,
  researchBudget,
  researchJobRef,
  researchReportList,
} from "./research-fixtures.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const startInput = {
  version: 1 as const,
  target: { type: "page" as const, logicalPageId: 1 },
  question: "What is useful for this project?",
  includeShareableContext: true,
  maxIncludedSources: 25,
  budget: researchBudget,
  confirmedOrigins: {
    authenticatedOriginDigests: [] as string[],
    sensitiveOriginDigests: [] as string[],
  },
  idempotencyKey: "research-page-1-v1",
  authorizationRef: "user-instruction:research-page-1-v1",
};

describe("TabHub trusted-loopback research REST adapter", () => {
  it("submits one declarative start-or-replay command and returns JobRef without polling", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(researchJobRef, 202));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.startResearch(startInput)).resolves.toEqual(researchJobRef);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls).toEqual([[
      "http://127.0.0.1:7717/api/agent/research/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startInput),
      },
    ]]);
  });

  it("returns only digest confirmation requirements without a second HTTP call", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(confirmationRequired));
    const api = createTabHubApi({ fetchImpl });

    const result = await api.startResearch(startInput);
    expect(result).toEqual(confirmationRequired);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(result);
    for (const canary of privateResearchCanaries) expect(serialized).not.toContain(canary);
    for (const forbidden of ["manifest", "corpusFingerprint", "confirmationDisplay"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("defaults omitted confirmed origins to an explicit empty set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(researchJobRef, 202));
    const api = createTabHubApi({ fetchImpl });
    const { confirmedOrigins: _omitted, ...withoutConfirmation } = startInput;

    await api.startResearch(withoutConfirmation);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual(startInput);
  });

  it.each([
    { parentReportId: null },
    { captureIntent: { selectedTabIds: [], knownFailures: [] } },
    { estimate: { estimateVersion: "research_estimate:v1" } },
    { approvalFingerprint: "a".repeat(64) },
    { provenance: { requestedBy: "agent" } },
  ])("rejects forbidden start input %# before HTTP", async (field) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTabHubApi({ fetchImpl });

    await expect(api.startResearch({ ...startInput, ...field } as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gets one research job and cancels only through the agent command route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(queuedResearchJob))
      .mockResolvedValueOnce(jsonResponse(cancelledResearchJob));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getAiJob("resource_research:41")).resolves
      .toEqual(queuedResearchJob);
    await expect(api.cancelAiJob("resource_research:41", {
      idempotencyKey: "cancel-research-41",
      authorizationRef: "user-instruction:cancel-research-41",
    })).resolves.toEqual(cancelledResearchJob);
    expect(fetchImpl.mock.calls).toEqual([
      ["http://127.0.0.1:7717/api/ai/jobs/resource_research:41", { method: "GET" }],
      ["http://127.0.0.1:7717/api/agent/ai/jobs/resource_research:41/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorizationRef: "user-instruction:cancel-research-41",
          idempotencyKey: "cancel-research-41",
        }),
      }],
    ]);
  });

  it.each([
    ["get", () => createTabHubApi({ fetchImpl: vi.fn<typeof fetch>() })
      .getAiJob("priority_assessment:41")],
    ["cancel", () => createTabHubApi({ fetchImpl: vi.fn<typeof fetch>() })
      .cancelAiJob("resource_research:0", {
        idempotencyKey: "cancel-research-0",
        authorizationRef: "user-instruction:cancel-research-0",
      })],
  ])("rejects an invalid %s research job identity before HTTP", async (_name, invoke) => {
    await expect(invoke()).rejects.toThrow();
  });

  it("lists bounded agent-safe report history and gets one report", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(researchReportList))
      .mockResolvedValueOnce(jsonResponse(agentResearchReportDetail));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.listResearchReports({
      targetType: "page",
      targetId: 1,
      limit: 25,
      beforeVersion: 4,
    })).resolves.toEqual(researchReportList);
    await expect(api.getResearchReport(21)).resolves.toEqual(agentResearchReportDetail);
    expect(fetchImpl.mock.calls).toEqual([
      [
        "http://127.0.0.1:7717/api/agent/research/reports?targetType=page&targetId=1&limit=25&beforeVersion=4",
        { method: "GET" },
      ],
      ["http://127.0.0.1:7717/api/agent/research/reports/21", { method: "GET" }],
    ]);
  });

  it("rejects invalid report input before HTTP and mismatched identities after HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      ...queuedResearchJob,
      id: "resource_research:42",
    })).mockResolvedValueOnce(jsonResponse({
      ...researchReportList,
      target: { type: "page", logicalPageId: 2 },
    })).mockResolvedValueOnce(jsonResponse({
      ...agentResearchReportDetail,
      id: 22,
    }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.listResearchReports({
      targetType: "page",
      targetId: 1,
      limit: 25,
      beforeVersion: 0,
    } as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(api.getAiJob("resource_research:41"))
      .rejects.toThrow("mismatched response");
    await expect(api.listResearchReports({
      targetType: "page",
      targetId: 1,
      limit: 25,
      beforeVersion: 4,
    })).rejects.toThrow("mismatched response");
    await expect(api.getResearchReport(21)).rejects.toThrow("mismatched response");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails closed on unsafe report response fields without echoing private material", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      ...agentResearchReportDetail,
      rawLocator: privateResearchCanaries[3],
      url: privateResearchCanaries[0],
      excerpt: privateResearchCanaries[2],
    }));
    const api = createTabHubApi({ fetchImpl });

    const error = await api.getResearchReport(21).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid response");
    for (const canary of privateResearchCanaries) {
      expect((error as Error).message).not.toContain(canary);
    }
  });

  it.each([
    [409, "FEATURE_DISABLED"],
    [503, "RESEARCH_PROVIDER_UNAVAILABLE"],
    [422, "RESEARCH_CAPTURE_REQUIRED"],
    [409, "IDEMPOTENCY_KEY_CONFLICT"],
  ])("exposes only typed server code %s/%s on research failures", async (
    status,
    code,
  ) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      error: code,
      message: privateResearchCanaries[8],
    }, status));
    const api = createTabHubApi({ fetchImpl });

    const error = await api.startResearch(startInput).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(code);
    expect((error as Error).message).not.toContain(privateResearchCanaries[8]);
  });
});
