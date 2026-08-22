import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";

import { runG0Baseline } from "./baseline-runner.js";

interface CliOptions {
  readonly samples: number;
  readonly sourcePath: string;
  readonly syntheticRows: number;
  readonly workDirectory?: string;
}

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(workspaceRoot, ".env"), quiet: true });

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

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): CliOptions {
  let samples = 20;
  let sourcePath = resolve(
    workspaceRoot,
    process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
  );
  let syntheticRows = 10_000;
  let workDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--":
        break;
      case "--samples":
        samples = positiveInteger(
          requiredValue(args, index, argument),
          argument,
        );
        index += 1;
        break;
      case "--source":
        sourcePath = resolve(requiredValue(args, index, argument));
        index += 1;
        break;
      case "--synthetic-rows":
        syntheticRows = positiveInteger(
          requiredValue(args, index, argument),
          argument,
        );
        index += 1;
        break;
      case "--work-dir":
        workDirectory = resolve(requiredValue(args, index, argument));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    samples,
    sourcePath,
    syntheticRows,
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
    `g0-baseline-${timestampSlug()}`,
  );

const result = await runG0Baseline({
  samples: options.samples,
  sourcePath: options.sourcePath,
  syntheticRows: options.syntheticRows,
  workDirectory,
});
console.log(
  JSON.stringify(
    {
      ...result,
      workDirectory,
      workDirectoryRetained: true,
    },
    null,
    2,
  ),
);
