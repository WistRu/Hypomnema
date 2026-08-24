import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  availabilitySpans,
  createRuntimeAvailabilityRecorder,
  parseAvailabilityRecords,
  startupRecords,
  type RuntimeAvailabilityRecord,
} from "../src/runtime-availability.js";

const started = (at: string, sessionId: string): RuntimeAvailabilityRecord =>
  ({ event: "started", at, sessionId, pid: 1 });
const stopped = (at: string, sessionId: string): RuntimeAvailabilityRecord =>
  ({ event: "stopped", at, sessionId });
const lost = (at: string, sessionId: string): RuntimeAvailabilityRecord =>
  ({ event: "lost", at, sessionId });

describe("startupRecords", () => {
  it("records only a start when nothing was running before", () => {
    expect(startupRecords(undefined, [], {
      at: "2026-08-24T09:00:00.000Z", sessionId: "s1", pid: 10
    })).toEqual([
      { event: "started", at: "2026-08-24T09:00:00.000Z", sessionId: "s1", pid: 10 },
    ]);
  });

  it("records only a start when the previous session stopped cleanly", () => {
    const records = startupRecords(
      { at: "2026-08-24T01:00:00.000Z", sessionId: "s0", pid: 9 },
      [started("2026-08-24T00:00:00.000Z", "s0"), stopped("2026-08-24T01:05:00.000Z", "s0")],
      { at: "2026-08-24T09:00:00.000Z", sessionId: "s1", pid: 10 },
    );
    expect(records.map((record) => record.event)).toEqual(["started"]);
  });

  it("marks a previous session that died without stopping, and when it was last alive", () => {
    // The whole point: a hard kill leaves no "stopped", so the only honest
    // end of that outage is the last heartbeat it managed to write.
    const records = startupRecords(
      { at: "2026-08-24T01:51:00.000Z", sessionId: "s0", pid: 9 },
      [started("2026-08-24T00:00:00.000Z", "s0")],
      { at: "2026-08-24T09:47:00.000Z", sessionId: "s1", pid: 10 },
    );
    expect(records).toEqual([
      { event: "lost", at: "2026-08-24T01:51:00.000Z", sessionId: "s0" },
      { event: "started", at: "2026-08-24T09:47:00.000Z", sessionId: "s1", pid: 10 },
    ]);
  });

  it("does not invent a heartbeat for a session it cannot vouch for", () => {
    // No heartbeat survived, so the last-alive moment is unknown rather than
    // the start time — claiming the latter would understate the outage.
    const records = startupRecords(
      undefined,
      [started("2026-08-24T00:00:00.000Z", "s0")],
      { at: "2026-08-24T09:47:00.000Z", sessionId: "s1", pid: 10 },
    );
    expect(records).toEqual([
      { event: "lost", at: null, sessionId: "s0" },
      { event: "started", at: "2026-08-24T09:47:00.000Z", sessionId: "s1", pid: 10 },
    ]);
  });
});

describe("availabilitySpans", () => {
  it("turns a clean run into one up span", () => {
    expect(availabilitySpans([
      started("2026-08-24T00:00:00.000Z", "s0"),
      stopped("2026-08-24T01:00:00.000Z", "s0"),
    ], "2026-08-24T02:00:00.000Z")).toEqual([
      { state: "up", from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T01:00:00.000Z" },
      { state: "down", from: "2026-08-24T01:00:00.000Z", to: "2026-08-24T02:00:00.000Z" },
    ]);
  });

  it("reports the outage a crash leaves behind, bounded by the last heartbeat", () => {
    expect(availabilitySpans([
      started("2026-08-24T00:00:00.000Z", "s0"),
      lost("2026-08-24T01:51:00.000Z", "s0"),
      started("2026-08-24T09:47:00.000Z", "s1"),
    ], "2026-08-24T10:00:00.000Z")).toEqual([
      { state: "up", from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T01:51:00.000Z" },
      { state: "down", from: "2026-08-24T01:51:00.000Z", to: "2026-08-24T09:47:00.000Z" },
      { state: "up", from: "2026-08-24T09:47:00.000Z", to: "2026-08-24T10:00:00.000Z" },
    ]);
  });

  it("leaves an outage open-ended when the last-alive moment is unknown", () => {
    // Better an unbounded gap than a confident wrong one: a reader must be
    // able to see that the runtime's own record cannot say.
    expect(availabilitySpans([
      started("2026-08-24T00:00:00.000Z", "s0"),
      { event: "lost", at: null, sessionId: "s0" },
      started("2026-08-24T09:47:00.000Z", "s1"),
    ], "2026-08-24T10:00:00.000Z")).toEqual([
      { state: "up", from: "2026-08-24T00:00:00.000Z", to: null },
      { state: "down", from: null, to: "2026-08-24T09:47:00.000Z" },
      { state: "up", from: "2026-08-24T09:47:00.000Z", to: "2026-08-24T10:00:00.000Z" },
    ]);
  });

  it("says nothing at all rather than guessing from an empty record", () => {
    expect(availabilitySpans([], "2026-08-24T10:00:00.000Z")).toEqual([]);
  });
});

describe("the recorder, through real files", () => {
  async function workspace() {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-availability-"));
    return {
      directory,
      logPath: join(directory, "nested", "availability.jsonl"),
      heartbeatPath: join(directory, "nested", "heartbeat.json"),
    };
  }

  it("reconstructs an outage a hard kill left behind", async () => {
    const { directory, logPath, heartbeatPath } = await workspace();
    try {
      // A session that starts, beats, and is then killed without stopping —
      // exactly what a power loss does. Nothing writes on its way out.
      const killed = createRuntimeAvailabilityRecorder({
        logPath, heartbeatPath, sessionId: "s0", pid: 9,
        at: "2026-08-24T00:00:00.000Z",
      });
      killed.beat("2026-08-24T01:51:00.000Z");

      createRuntimeAvailabilityRecorder({
        logPath, heartbeatPath, sessionId: "s1", pid: 10,
        at: "2026-08-24T09:47:00.000Z",
      });

      const records = parseAvailabilityRecords(await readFile(logPath, "utf8"));
      expect(availabilitySpans(records, "2026-08-24T10:00:00.000Z")).toEqual([
        { state: "up", from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T01:51:00.000Z" },
        { state: "down", from: "2026-08-24T01:51:00.000Z", to: "2026-08-24T09:47:00.000Z" },
        { state: "up", from: "2026-08-24T09:47:00.000Z", to: "2026-08-24T10:00:00.000Z" },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a clean stop clean, and creates the directory it needs", async () => {
    const { directory, logPath, heartbeatPath } = await workspace();
    try {
      const recorder = createRuntimeAvailabilityRecorder({
        logPath, heartbeatPath, sessionId: "s0", pid: 9,
        at: "2026-08-24T00:00:00.000Z",
      });
      recorder.stop("2026-08-24T01:00:00.000Z");
      recorder.stop("2026-08-24T01:30:00.000Z");
      recorder.beat("2026-08-24T01:40:00.000Z");

      const records = parseAvailabilityRecords(await readFile(logPath, "utf8"));
      expect(records.filter((record) => record.event === "stopped")).toHaveLength(1);
      expect(availabilitySpans(records, "2026-08-24T02:00:00.000Z")).toEqual([
        { state: "up", from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T01:00:00.000Z" },
        { state: "down", from: "2026-08-24T01:00:00.000Z", to: "2026-08-24T02:00:00.000Z" },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("survives a half-written final line instead of losing the whole record", () => {
    const whole = JSON.stringify({
      event: "started", at: "2026-08-24T00:00:00.000Z",
      sessionId: "s0", pid: 9,
    });
    // Newline via char code: the escape itself is what a torn line is about.
    const torn = [whole, '{"event":"sto'].join(String.fromCharCode(10));

    expect(parseAvailabilityRecords(torn)).toHaveLength(1);
  });
});

describe("a log that does not make sense", () => {
  it("does not silently swallow an up span when a start is never closed", () => {
    // Two starts with no close between them can only mean a record that lost
    // something. Dropping the first span quietly would under-report uptime
    // with nothing to show the reader that anything was missing.
    expect(availabilitySpans([
      started("2026-08-24T00:00:00.000Z", "s0"),
      started("2026-08-24T05:00:00.000Z", "s1"),
    ], "2026-08-24T06:00:00.000Z")).toEqual([
      { state: "up", from: "2026-08-24T00:00:00.000Z", to: null },
      { state: "up", from: "2026-08-24T05:00:00.000Z", to: "2026-08-24T06:00:00.000Z" },
    ]);
  });

  it("reports a stop with no start as downtime rather than inventing uptime", () => {
    expect(availabilitySpans([
      stopped("2026-08-24T01:00:00.000Z", "s0"),
    ], "2026-08-24T02:00:00.000Z")).toEqual([
      { state: "down", from: "2026-08-24T01:00:00.000Z", to: "2026-08-24T02:00:00.000Z" },
    ]);
  });

  it("closes only the session it belongs to across two consecutive crashes", () => {
    const records = startupRecords(
      { at: "2026-08-24T05:30:00.000Z", sessionId: "s1", pid: 10 },
      [
        started("2026-08-24T00:00:00.000Z", "s0"),
        lost("2026-08-24T01:00:00.000Z", "s0"),
        started("2026-08-24T05:00:00.000Z", "s1"),
      ],
      { at: "2026-08-24T09:00:00.000Z", sessionId: "s2", pid: 11 },
    );
    expect(records).toEqual([
      { event: "lost", at: "2026-08-24T05:30:00.000Z", sessionId: "s1" },
      { event: "started", at: "2026-08-24T09:00:00.000Z", sessionId: "s2", pid: 11 },
    ]);
  });
});
