import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Fails a test run that executed fewer files than the package has.
 *
 * Issue #36: a worker that dies takes its files with it, and vitest still
 * prints a summary with a total, so the run reports a number as though it had
 * finished. A green summary over a short run is worse than a red one — it is a
 * false negative that nobody has any reason to question.
 *
 * Compares the JSON report against the files actually on disk and names the
 * difference, because "132 of 137" sends you hunting while "these five never
 * ran" does not.
 */
const packageDirectory = resolve(process.argv[2] ?? ".");
/**
 * The directories the package's vitest `include` actually covers, passed
 * explicitly. Scanning the whole package instead would drift the moment a
 * config narrows its include — `@tabhub/server` restricts to `test/**`, so a
 * `src/*.test.ts` there would be reported missing forever by a guard that
 * looked everywhere.
 */
const searchRoots = process.argv.slice(3);
if (searchRoots.length === 0) {
  console.error("Test completeness: no search directories given.");
  console.error("Usage: check-test-completeness.mjs <packageDir> <testDir...>");
  process.exit(1);
}
const reportPath = join(packageDirectory, ".vitest-report.json");

const IGNORED = new Set(["node_modules", "dist", ".output", ".wxt", "coverage"]);

function testFilesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFilesUnder(full));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  // No report at all means the run did not reach the end. Saying so is the
  // whole job; staying quiet would reproduce the defect this guards against.
  console.error(`Test completeness: no report at ${reportPath}.`);
  console.error(`The run did not finish. (${error.message})`);
  process.exit(1);
}

const normalise = (value) => resolve(value).split(sep).join("/");
const executed = new Set((report.testResults ?? []).map((r) => normalise(r.name)));
const onDisk = searchRoots
  .flatMap((root) => testFilesUnder(join(packageDirectory, root)))
  .map(normalise);

if (onDisk.length === 0) {
  // A guard that approves an empty set is not a guard. Unreachable today
  // because vitest fails on no tests, but --passWithNoTests would make this
  // silently vacuous, which is the failure mode being guarded against.
  console.error(
    `Test completeness: found no test files under ${searchRoots.join(", ")}. ` +
      "Either the search directories are wrong or the package lost its tests; " +
      "both are failures, not a pass.",
  );
  process.exit(1);
}
const missing = onDisk.filter((file) => !executed.has(file));

if (missing.length > 0) {
  console.error(
    `Test completeness: ${executed.size} of ${onDisk.length} files ran. ` +
      `${missing.length} never executed:`,
  );
  for (const file of missing) {
    console.error(`  ${relative(packageDirectory, file).split(sep).join("/")}`);
  }
  console.error("");
  console.error(
    "A run that skips files silently reports a total it did not earn. " +
      "Treat this as a failed run, not a flaky one.",
  );
  process.exit(1);
}

// Reported even on success: a count nobody prints is a count nobody checks.
console.log(`Test completeness: all ${onDisk.length} test files ran.`);
