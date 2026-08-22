import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("page summary capture static boundary", () => {
  it("uses only the exact relay control and revision-bound summary APIs", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/PageSummaryCaptureControl.tsx"),
      "utf8",
    );

    expect(source).toContain("<ExactCaptureControl");
    expect(source).toContain("expectedContentRevision:");
    expect(source).not.toMatch(/window\.open|location\.(?:assign|replace)|openUrl|openInBrowser/);
  });

  it("leaves the Library short-summary labels and action implementation intact", () => {
    const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

    expect(source).toContain("enqueueShortSummary(tab.id)");
    expect(source).toContain('t("Create short summary")');
    expect(source).toContain('t("Refresh short summary")');
    expect(source).not.toContain("PageSummaryCaptureControl");
  });
});
