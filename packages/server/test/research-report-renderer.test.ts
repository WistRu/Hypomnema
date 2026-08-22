import { describe, expect, it } from "vitest";

import { renderResearchReportText } from "../src/research-report-renderer.js";

const hash = "a".repeat(64);
const dossier = {
  executiveSummary: "A concise finding.",
  valueForUser: "It reduces manual review.",
  capabilities: ["Indexes evidence", "Keeps history"],
  limitations: [],
  risks: ["Captured material can become stale"],
  unknowns: ["Long-term usefulness"],
  nextSteps: ["Review claim one"],
};

describe("research report renderer", () => {
  it("renders one deterministic report text from the closed dossier and normalized claims", () => {
    const claims = [{
      claim: "The captured page supports the finding.",
      confidence: 0.9,
      isInference: false,
      rationale: null,
      evidence: [{
        kind: "tab_content" as const,
        sourceId: 7,
        locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 8 },
        excerptHash: hash,
      }],
    }, {
      claim: "The resource may remain useful.",
      confidence: 0.625,
      isInference: true,
      rationale: "Several capabilities remain relevant.",
      evidence: [],
    }];
    const expected = [
      "# Executive summary",
      "A concise finding.",
      "# Value for user",
      "It reduces manual review.",
      "# Capabilities",
      "- Indexes evidence\n- Keeps history",
      "# Limitations",
      "- None",
      "# Risks",
      "- Captured material can become stale",
      "# Unknowns",
      "- Long-term usefulness",
      "# Next steps",
      "- Review claim one",
      "# Claims",
      "1. [900,e] The captured page supports the finding.\n" +
        "2. [625,i] The resource may remain useful. | Several capabilities remain relevant.",
    ].join("\n\n");

    expect(renderResearchReportText(dossier, claims)).toBe(expected);
    expect(renderResearchReportText(structuredClone(dossier), structuredClone(claims)))
      .toBe(expected);
    expect(Buffer.byteLength(expected, "utf8")).toBeLessThanOrEqual(1_000_000);
  });

  it("rejects material outside the same strict publication schemas", () => {
    expect(() => Reflect.apply(renderResearchReportText, undefined, [
      { ...dossier, extra: true },
      [],
    ])).toThrow();
    expect(() => renderResearchReportText(dossier, [{
      claim: "Unsupported fact",
      confidence: 0.5,
      isInference: false,
      rationale: null,
      evidence: [],
    }])).toThrow(/requires evidence/i);
  });

  it("keeps the largest high-cardinality accepted shape within the stored text limit", () => {
    const largeDossier = {
      ...dossier,
      executiveSummary: "x",
      valueForUser: "x",
      capabilities: Array.from({ length: 63 }, () => "x".repeat(4096)),
      limitations: [],
      risks: [],
      unknowns: [],
      nextSteps: [],
    };
    const evidence = {
      kind: "tab_content" as const,
      sourceId: 1,
      locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 1 },
      excerptHash: hash,
    };
    const claims = Array.from({ length: 10_000 }, () => ({
      claim: "x".repeat(52),
      confidence: 1,
      isInference: false,
      rationale: null,
      evidence: [evidence],
    }));

    expect(Buffer.byteLength(renderResearchReportText(largeDossier, claims), "utf8"))
      .toBeLessThanOrEqual(1_000_000);
  });
});
