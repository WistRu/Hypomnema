import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { q10kG6V1 } from "./baseline-contract.js";
import { runG6Baseline } from "./baseline-g6-runner.js";

interface CliOptions { readonly sourcePath: string; readonly workDirectory?: string }

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function value(args: readonly string[], index: number, name: string): string {
  const result = args[index + 1];
  if (result === undefined) throw new Error(`${name} requires a value`);
  return result;
}

function parse(args: readonly string[]): CliOptions {
  let sourcePath: string | undefined; let workDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--source") {
      sourcePath = resolve(workspaceRoot, value(args, index, argument)); index += 1;
    } else if (argument === "--work-dir") {
      workDirectory = resolve(workspaceRoot, value(args, index, argument)); index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { sourcePath: sourcePath ?? resolve(q10kG6V1.fixture.acceptedSourcePath),
    ...(workDirectory === undefined ? {} : { workDirectory }) };
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

const options = parse(process.argv.slice(2));
const workDirectory = options.workDirectory ?? resolve(workspaceRoot, ".tmp",
  "personal-attention-layer", `g6-baseline-${timestamp()}`);
const result = await runG6Baseline({ sourcePath: options.sourcePath, workDirectory });
console.log(JSON.stringify({ ...result, workDirectory, workDirectoryRetained: true }, null, 2));
if (!result.passed) process.exitCode = 1;
