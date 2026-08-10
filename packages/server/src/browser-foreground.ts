import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface BrowserWindowBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface BrowserForegroundTarget {
  bounds?: BrowserWindowBounds | undefined;
  browser: string;
  title?: string | undefined;
}

export type BrowserForegroundHandoffResult =
  | {
      ok: true;
      processId?: number | undefined;
      windowHandle?: string | undefined;
    }
  | {
      ok: false;
      reason:
        | "AMBIGUOUS_MATCH"
        | "FOCUS_FAILED"
        | "HELPER_EXECUTION_FAILED"
        | "INVALID_HELPER_RESPONSE"
        | "NO_MATCH"
        | "UNSUPPORTED_BROWSER"
        | "WINDOW_METADATA_UNAVAILABLE";
    };

export type BrowserForegroundHandoff = (
  target: BrowserForegroundTarget,
) => Promise<BrowserForegroundHandoffResult>;

interface BrowserForegroundHandoffOptions {
  executablePath?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  runHelper?: ((arguments_: readonly string[]) => Promise<string>) | undefined;
}

const processNamesByBrowser: Readonly<Record<string, readonly string[]>> = {
  chrome: ["chrome"],
  edge: ["msedge"],
  yandex: ["browser"],
};
const execFileAsync = promisify(execFile);

function executableRunner(
  executablePath: string,
): (arguments_: readonly string[]) => Promise<string> {
  return async (arguments_) => {
    try {
      const { stdout } = await execFileAsync(executablePath, [...arguments_], {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        timeout: 3_000,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        error.stdout.trim() !== ""
      ) {
        return error.stdout;
      }
      throw error;
    }
  };
}

function parseHelperOutput(output: string): BrowserForegroundHandoffResult {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const line of lines) {
    const success = /^OK\|(\d+)\|([0-9A-F]+)$/u.exec(line);
    if (success !== null) {
      return {
        ok: true,
        processId: Number.parseInt(success[1]!, 10),
        windowHandle: success[2]!,
      };
    }
    if (
      line === "AMBIGUOUS_MATCH" ||
      line === "FOCUS_FAILED" ||
      line === "NO_MATCH"
    ) {
      return { ok: false, reason: line };
    }
  }
  return { ok: false, reason: "INVALID_HELPER_RESPONSE" };
}

export function createWindowsBrowserForegroundHandoff(
  options: BrowserForegroundHandoffOptions = {},
): BrowserForegroundHandoff {
  const platform = options.platform ?? process.platform;
  const run =
    options.runHelper ??
    (options.executablePath === undefined
      ? undefined
      : executableRunner(options.executablePath));

  return async (target) => {
    if (platform !== "win32") return { ok: true };
    const processNames = processNamesByBrowser[target.browser];
    if (processNames === undefined) {
      return { ok: false, reason: "UNSUPPORTED_BROWSER" };
    }
    if (run === undefined) {
      return { ok: false, reason: "HELPER_EXECUTION_FAILED" };
    }
    if (target.bounds === undefined && !target.title?.trim()) {
      return { ok: false, reason: "WINDOW_METADATA_UNAVAILABLE" };
    }

    try {
      const output = await run([
        processNames.join(","),
        target.title?.trim() ?? "",
        String(target.bounds?.left ?? 0),
        String(target.bounds?.top ?? 0),
        String(target.bounds?.width ?? 0),
        String(target.bounds?.height ?? 0),
      ]);
      return parseHelperOutput(output);
    } catch {
      return { ok: false, reason: "HELPER_EXECUTION_FAILED" };
    }
  };
}
