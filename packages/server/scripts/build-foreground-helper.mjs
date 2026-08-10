import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const serverRoot = fileURLToPath(new URL("../", import.meta.url));
  const outputDirectory = resolve(serverRoot, "native/bin");
  const outputPath = resolve(outputDirectory, "tabhub-foreground.exe");
  const sourcePath = resolve(serverRoot, "native/TabHubForeground.cs");
  const windowsDirectory = process.env.WINDIR ?? "C:\\Windows";
  const compilerPath = resolve(
    windowsDirectory,
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );
  mkdirSync(outputDirectory, { recursive: true });
  const result = spawnSync(
    compilerPath,
    [
      "/nologo",
      "/optimize+",
      "/target:exe",
      `/out:${outputPath}`,
      sourcePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not build the Windows foreground helper.\n${result.stdout}${result.stderr}`,
    );
  }
  console.log(`Built ${outputPath}`);
}
