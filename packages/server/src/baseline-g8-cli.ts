import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { q10kG8V1, runG8Baseline } from "./baseline-g8-runner.js";

interface CliOptions {
  readonly sourcePath: string;
  readonly workDirectory?: string;
}

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function requiredValue(
  arguments_: readonly string[],
  index: number,
  name: string,
): string {
  const value = arguments_[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(arguments_: readonly string[]): CliOptions {
  let sourcePath: string | undefined;
  let workDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--source") {
      sourcePath = resolve(workspaceRoot, requiredValue(arguments_, index, argument));
      index += 1;
    } else if (argument === "--work-dir") {
      workDirectory = resolve(workspaceRoot, requiredValue(arguments_, index, argument));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return {
    sourcePath: sourcePath ?? resolve(q10kG8V1.fixture.acceptedSourcePath),
    ...(workDirectory === undefined ? {} : { workDirectory }),
  };
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

const options = parseOptions(process.argv.slice(2));
const workDirectory = options.workDirectory ?? resolve(
  workspaceRoot,
  ".tmp",
  "personal-attention-layer",
  `g8-baseline-${timestamp()}`,
);
const run = await runG8Baseline({
  sourcePath: options.sourcePath,
  workDirectory,
});
console.log(JSON.stringify({
  ...run,
  workDirectory,
  workDirectoryRetained: true,
}, null, 2));
if (!run.result.passed) process.exitCode = 1;
