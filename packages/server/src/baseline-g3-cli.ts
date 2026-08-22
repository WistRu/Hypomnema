import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runG3Baseline } from "./baseline-g3-runner.js";

interface CliOptions {
  readonly sourcePath: string;
  readonly workDirectory?: string;
}

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function timestampSlug(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function requiredValue(args: readonly string[], index: number, name: string) {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args: readonly string[]): CliOptions {
  let sourcePath: string | undefined;
  let workDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--":
        break;
      case "--source":
        sourcePath = resolve(
          workspaceRoot,
          requiredValue(args, index, argument),
        );
        index += 1;
        break;
      case "--work-dir":
        workDirectory = resolve(
          workspaceRoot,
          requiredValue(args, index, argument),
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (sourcePath === undefined) {
    throw new Error("--source is required and must name the accepted S10K-v1 fixture");
  }
  return {
    sourcePath,
    ...(workDirectory === undefined ? {} : { workDirectory }),
  };
}

const options = parseOptions(process.argv.slice(2));
const workDirectory =
  options.workDirectory ??
  resolve(
    workspaceRoot,
    ".tmp",
    "personal-attention-layer",
    `g3-baseline-${timestampSlug()}`,
  );
const result = await runG3Baseline({
  sourcePath: options.sourcePath,
  workDirectory,
});
console.log(
  JSON.stringify(
    { ...result, workDirectory, workDirectoryRetained: true },
    null,
    2,
  ),
);
if (!result.passed) {
  process.exitCode = 1;
}
