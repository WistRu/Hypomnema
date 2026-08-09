import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/i18n")>();
  return {
    ...original,
    useI18n: () => ({
      formatNumber: (value: number) => String(value),
      t: (key: string, params: Record<string, number | string> = {}) =>
        original.translate("en", key, params),
    }),
  };
});

import { DuplicateGroupsCloseAllDialog } from "../src/DuplicateGroupsCloseAllDialog";

describe("DuplicateGroupsCloseAllDialog", () => {
  it("summarizes one confirmation across groups and browser profiles", () => {
    const markup = renderToStaticMarkup(
      <DuplicateGroupsCloseAllDialog
        blockedCandidateCount={3}
        blockedGroupCount={2}
        busy={false}
        candidateCount={17}
        confirmationBlocked={false}
        excludedProfiles={[
          {
            candidateCount: 3,
            groupCount: 2,
            label: "Edge · installation xyz",
            reason: "Browser profile offline",
          },
        ]}
        groupCount={8}
        profiles={[
          { candidateCount: 11, label: "Chrome · installation abc" },
          { candidateCount: 6, label: "Yandex · installation def" },
        ]}
        profileCount={2}
        protectedCopyCount={4}
        protectedGroupCount={3}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("Close 17 extra exact copies?");
    expect(markup).toContain("each of 8 exact-URL groups");
    expect(markup).toContain("at least one copy");
    expect(markup).toContain("across 2 connected browser profiles");
    expect(markup).toContain("3 extra copies in 2 unavailable groups");
    expect(markup).toContain("Chrome · installation abc");
    expect(markup).toContain("11 ready to close");
    expect(markup).toContain("finish independently");
    expect(markup).toContain("4 pinned copies in 3 groups will remain open");
    expect(markup).toContain("Excluded from this cleanup");
    expect(markup).toContain("Edge · installation xyz");
    expect(markup).toContain("Browser profile offline");
    expect(markup).toContain("Close duplicate copies");
  });

  it("blocks confirmation when the aggregate preview is stale", () => {
    const markup = renderToStaticMarkup(
      <DuplicateGroupsCloseAllDialog
        blockedCandidateCount={0}
        blockedGroupCount={0}
        blockingMessage="The live duplicate preview changed."
        busy={false}
        candidateCount={4}
        confirmationBlocked
        excludedProfiles={[]}
        groupCount={2}
        profiles={[{ candidateCount: 4, label: "Chrome" }]}
        profileCount={1}
        protectedCopyCount={0}
        protectedGroupCount={0}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("The live duplicate preview changed.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Close duplicate copies<\/button>/);
  });
});
