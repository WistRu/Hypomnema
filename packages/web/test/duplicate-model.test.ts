import type { DuplicateGroupListResponse } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  buildCloseConfirmation,
  duplicateGroupView,
  duplicateReviewSummary,
} from "../src/duplicate-model";

function duplicateResponse(): DuplicateGroupListResponse {
  return {
    items: [
      {
        installationId: "chrome-main",
        browser: "chrome",
        url: "https://example.com/exact",
        count: 4,
        keeperInstanceId: 11,
        candidateInstanceIds: [12, 13],
        protectedInstanceIds: [14],
        instances: [],
      },
      {
        installationId: "edge-main",
        browser: "edge",
        url: "https://example.com/edge",
        count: 2,
        keeperInstanceId: 21,
        candidateInstanceIds: [22],
        protectedInstanceIds: [],
        instances: [],
      },
    ],
    totalGroups: 2,
    totalTabsInGroups: 6,
    totalDuplicateCopies: 4,
    totalCloseCandidates: 3,
    totalProtected: 1,
    page: 1,
    pageSize: 50,
  };
}

describe("duplicate review model", () => {
  it("separates all exact duplicate counts from tabs controllable by this installation", () => {
    const response = duplicateResponse();

    expect(duplicateReviewSummary(response, "chrome-main")).toEqual({
      exactGroups: 2,
      physicalTabs: 6,
      duplicateCopies: 4,
      allInstallationCandidates: 3,
      protectedTabs: 1,
      controllableGroups: 1,
      controllableCandidates: 2,
    });
  });

  it("enables closing only for the connected installation and explains protected tabs", () => {
    const [chromeGroup, edgeGroup] = duplicateResponse().items;

    expect(duplicateGroupView(chromeGroup!, "chrome-main")).toMatchObject({
      canClose: true,
      closeCandidateCount: 2,
      protectedCount: 1,
      reason: null,
    });
    expect(duplicateGroupView(edgeGroup!, "chrome-main")).toMatchObject({
      canClose: false,
      closeCandidateCount: 1,
      protectedCount: 0,
      reason: "Open TabHub in Edge to close these duplicates.",
    });
    expect(duplicateGroupView(chromeGroup!, null)).toMatchObject({
      canClose: false,
      reason: "TabHub extension is not connected to this page.",
    });
  });

  it("builds a two-step confirmation from safe candidates, not count minus one", () => {
    const confirmation = buildCloseConfirmation(
      duplicateResponse().items,
      "chrome-main",
    );

    expect(confirmation).toEqual({
      installationId: "chrome-main",
      browser: "chrome",
      groupCount: 1,
      candidateInstanceIds: [12, 13],
      closeCount: 2,
      protectedCount: 1,
    });
  });
});
