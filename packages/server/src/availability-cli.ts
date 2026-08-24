import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  availabilitySpans,
  parseAvailabilityRecords,
  type AvailabilitySpan,
} from "./runtime-availability.js";

/**
 * Answers the question issue #37 was filed for: was the runtime down, or was
 * nobody using it? Those look identical from the data and mean opposite things
 * for the Trial week.
 */
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const logPath = resolve(workspaceRoot, "data/runtime-availability.jsonl");

function duration(from: string | null, to: string | null): string {
  if (from === null || to === null) return "unknown";
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function render(span: AvailabilitySpan): string {
  return [
    span.state === "down" ? "DOWN" : "up  ",
    (span.from ?? "unknown").padEnd(24),
    "->",
    (span.to ?? "unknown").padEnd(24),
    duration(span.from, span.to),
  ].join(" ");
}

let contents: string;
try {
  contents = readFileSync(logPath, "utf8");
} catch {
  console.log(`No availability record yet at ${logPath}.`);
  console.log("It is written by the server itself, so it appears once the server has run.");
  process.exit(0);
}

const spans = availabilitySpans(
  parseAvailabilityRecords(contents),
  new Date().toISOString(),
);
if (spans.length === 0) {
  console.log("The availability record is empty.");
  process.exit(0);
}

for (const span of spans) console.log(render(span));

const outages = spans.filter((span) => span.state === "down");
console.log("");
console.log(
  outages.length === 0
    ? "No outage recorded."
    : `${outages.length} outage(s) recorded. A day containing one is not a day of real use.`,
);
// An unknown boundary is not a rounding error: it means the runtime could not
// vouch for when it died, so any duration read across it would be invented.
if (outages.some((span) => span.from === null || span.to === null)) {
  console.log(
    "At least one outage has an unknown boundary: no heartbeat survived that session.",
  );
}
