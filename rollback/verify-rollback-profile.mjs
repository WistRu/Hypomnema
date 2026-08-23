/**
 * C98 rollback-profile smoke.
 *
 * Proves that the Trial-week build, run with `trial-week-feature-off.env`, opens a
 * migrated copy of the live database, reports healthy on schema 26, serves Library
 * reads and writes nothing. It never touches the live file: the copy is taken through
 * SQLite's online backup API, so the daily server may keep running throughout.
 *
 * Usage: node rollback/verify-rollback-profile.mjs [--port 7799]
 * The result is printed as JSON on stdout, ready to be saved as a receipt.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { changedRowCounts, sha256File, tableRowCounts } from "./sqlite-facts.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// Resolved from the server package, which is where these native dependencies live.
const serverRequire = createRequire(join(repositoryRoot, "packages", "server", "index.js"));
const Database = serverRequire("better-sqlite3");
const sqliteVec = serverRequire("sqlite-vec");
const profilePath = join(repositoryRoot, "rollback", "trial-week-feature-off.env");
const buildArtifact = join(repositoryRoot, "packages", "server", "dist", "main.js");

const portFlagIndex = process.argv.indexOf("--port");
const port = portFlagIndex === -1 ? 7799 : Number(process.argv[portFlagIndex + 1]);

function parseEnvProfile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function readCounts(path) {
  const connection = new Database(path, { readonly: true });
  sqliteVec.load(connection);
  try {
    return {
      schemaVersion: connection.pragma("user_version", { simple: true }),
      integrityCheck: connection.pragma("integrity_check", { simple: true }),
      foreignKeyViolations: connection.pragma("foreign_key_check").length,
      rowCounts: tableRowCounts(connection),
    };
  } finally {
    connection.close();
  }
}

async function waitForHealth(baseUrl, deadlineMs = 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // The server is still starting; migrations on a large copy take a while.
    }
    if (Date.now() - started > deadlineMs) throw new Error("server never became healthy");
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** Healthy on schema 26, Library answering, and every projected flag off. */
function featureOffSmokePassed(smoke) {
  return smoke.health?.status === "ok" && smoke.health?.schemaVersion === 26 &&
    smoke.libraryRead.statusCode === 200 &&
    Object.values(smoke.features).every((flag) => flag === false);
}

const profileText = await readFile(profilePath, "utf8");
const profile = parseEnvProfile(profileText);
const livePath = resolve(repositoryRoot, profile.TABHUB_DB_PATH);
const liveHashBefore = await sha256File(livePath);

const directory = await mkdtemp(join(tmpdir(), "tabhub-c98-"));
const copyPath = join(directory, "rollback-copy.sqlite");
let receipt;
try {
  const source = new Database(livePath, { readonly: true });
  try {
    await source.backup(copyPath);
  } finally {
    source.close();
  }

  const before = readCounts(copyPath);
  const child = spawn(process.execPath, [buildArtifact], {
    cwd: repositoryRoot,
    // The profile pins the daily port and the live file; the smoke runs the same
    // profile against the copy on a spare port, and records that it did.
    env: { ...process.env, ...profile, TABHUB_PORT: String(port), TABHUB_DB_PATH: copyPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { logs.stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.stderr += String(chunk); });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(baseUrl);
    const features = await (await fetch(`${baseUrl}/api/features`)).json();
    const library = await fetch(`${baseUrl}/api/tabs?limit=1`);
    receipt = {
      profile: { path: "rollback/trial-week-feature-off.env", sha256: await sha256File(profilePath) },
      buildArtifact: { path: "packages/server/dist/main.js", sha256: await sha256File(buildArtifact) },
      port,
      pid: child.pid,
      liveDatabase: { path: profile.TABHUB_DB_PATH, sha256Before: liveHashBefore },
      copyBefore: { ...before, rowCounts: Object.fromEntries(before.rowCounts) },
      health,
      features,
      libraryRead: { route: "GET /api/tabs?limit=1", statusCode: library.status },
      logs: { stdoutTail: logs.stdout.trim().split("\n").slice(-3), stderr: logs.stderr.trim() },
    };
  } finally {
    child.kill();
    await new Promise((done) => child.once("exit", done));
  }

  const after = readCounts(copyPath);
  const changed = changedRowCounts(before.rowCounts, after.rowCounts);
  receipt.copyAfter = { ...after, rowCounts: Object.fromEntries(after.rowCounts) };
  receipt.tablesCounted = before.rowCounts.size;
  receipt.tableCountRule = "type = 'table' AND name NOT LIKE 'sqlite_%'";
  receipt.rowCountsChangedWhileServing = changed;
  // "No writer ran" has to mean something checkable: not one row moved in any table
  // while the profile was serving. This is that check, not a hand-written assurance.
  receipt.noWriterRan = changed.length === 0;
  receipt.liveDatabase.sha256After = await sha256File(livePath);
  receipt.liveDatabaseUnchanged =
    receipt.liveDatabase.sha256After === receipt.liveDatabase.sha256Before;
  receipt.verdict =
    receipt.noWriterRan &&
    receipt.liveDatabaseUnchanged &&
    featureOffSmokePassed(receipt) ? "PASS" : "FAIL";
} finally {
  await rm(directory, { force: true, recursive: true });
}


console.log(JSON.stringify(receipt, null, 2));
if (receipt.verdict !== "PASS") process.exitCode = 1;
