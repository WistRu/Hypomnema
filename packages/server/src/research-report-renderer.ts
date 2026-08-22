import {
  researchClaimListSchema,
  researchDossierSchema,
  type ResearchClaimDraft,
  type ResearchDossier,
} from "@tabhub/shared";

const reportTextByteLimit = 1_000_000;

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n");
}

function renderClaims(claims: readonly ResearchClaimDraft[]): string {
  if (claims.length === 0) return "- None";
  return claims.map((claim, index) => {
    const confidencePerMille = Math.round(claim.confidence * 1000);
    const kind = claim.isInference ? "i" : "e";
    const rationale = claim.rationale === null ? "" : ` | ${claim.rationale}`;
    return `${index + 1}. [${confidencePerMille},${kind}] ${claim.claim}${rationale}`;
  }).join("\n");
}

/**
 * The only report_text renderer. Publication callers provide semantic material,
 * never an independently authored text representation.
 */
export function renderResearchReportText(
  rawDossier: ResearchDossier,
  rawClaims: readonly ResearchClaimDraft[],
): string {
  const dossier = researchDossierSchema.parse(rawDossier);
  const claims = researchClaimListSchema.parse(rawClaims);
  const reportText = [
    "# Executive summary",
    dossier.executiveSummary,
    "# Value for user",
    dossier.valueForUser,
    "# Capabilities",
    renderList(dossier.capabilities),
    "# Limitations",
    renderList(dossier.limitations),
    "# Risks",
    renderList(dossier.risks),
    "# Unknowns",
    renderList(dossier.unknowns),
    "# Next steps",
    renderList(dossier.nextSteps),
    "# Claims",
    renderClaims(claims),
  ].join("\n\n");
  if (new TextEncoder().encode(reportText).byteLength > reportTextByteLimit) {
    throw new RangeError("Rendered research report exceeds 1,000,000 UTF-8 bytes");
  }
  return reportText;
}
