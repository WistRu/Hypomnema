import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Registers the autostart task as part of installing the project, so keeping
 * the runtime alive is not a step somebody has to remember (issue #37).
 *
 * Three rules, all of them about not being surprising:
 *
 *  - it never fails the install. A convenience that can break `pnpm install`
 *    is worse than no convenience;
 *  - it does nothing outside Windows and nothing in CI, where a per-user
 *    scheduled task is meaningless or unwanted;
 *  - it is idempotent, because `pnpm install` runs often and re-registering
 *    the same task must stay a no-op.
 *
 * Set TABHUB_SKIP_AUTOSTART=1 to opt out.
 */
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const installer = join(scriptDirectory, "install-autostart.ps1");

function skip(reason) {
  console.log(`TabHub autostart not configured: ${reason}`);
  process.exit(0);
}

if (process.env.TABHUB_SKIP_AUTOSTART === "1") skip("TABHUB_SKIP_AUTOSTART=1");
if (process.platform !== "win32") skip(`not supported on ${process.platform}`);
if (process.env.CI) skip("running in CI");
if (!existsSync(installer)) skip(`installer missing at ${installer}`);

const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer],
  { encoding: "utf8", windowsHide: true },
);

// Reported, never thrown: the user is installing dependencies, not asking for
// a scheduled task, and a failure here must not read as a failed install.
if (result.error || result.status !== 0) {
  console.log("TabHub autostart could not be configured automatically.");
  console.log(`Run it yourself when convenient: powershell -ExecutionPolicy Bypass -File ${installer}`);
  if (result.stderr?.trim()) console.log(result.stderr.trim().split("\n")[0]);
  process.exit(0);
}

console.log(result.stdout.trim() || "TabHub autostart configured.");
