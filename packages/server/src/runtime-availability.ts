import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The runtime's own record of when it was available.
 *
 * The Trial week counts days of real use, so "the user did not use TabHub" and
 * "TabHub was not running" have to be tellable apart afterwards, and on
 * 2026-08-24 they were not: the host lost power, the server died with it, and
 * eight hours passed before anyone noticed (issue #37).
 *
 * Deliberately a file rather than a table. The schema is frozen for the Trial
 * week so a migration is not available, and a file survives the cases a table
 * cannot — a locked database, a half-written page, a disk that came back after
 * the process did not.
 *
 * A hard kill writes nothing, so absence is the signal: a session that never
 * recorded `stopped` is closed by the next start, bounded by the last
 * heartbeat it managed to write. Where no heartbeat survived, the boundary is
 * `null` and stays unknown rather than being guessed at.
 */
export type RuntimeAvailabilityRecord =
  | {
      readonly event: "started";
      readonly at: string;
      readonly sessionId: string;
      readonly pid: number;
    }
  | { readonly event: "stopped"; readonly at: string; readonly sessionId: string }
  | { readonly event: "lost"; readonly at: string | null; readonly sessionId: string };

export interface RuntimeHeartbeat {
  readonly at: string;
  readonly sessionId: string;
  readonly pid: number;
}

export interface AvailabilitySpan {
  readonly state: "up" | "down";
  /** `null` when the runtime's own record cannot say when this boundary fell. */
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * What a starting runtime owes the record before it announces itself: if the
 * previous session never stopped, say so first, so the outage is bounded on
 * both sides instead of being inferable only by its absence.
 */
export function startupRecords(
  heartbeat: RuntimeHeartbeat | undefined,
  existing: readonly RuntimeAvailabilityRecord[],
  session: { at: string; sessionId: string; pid: number },
): RuntimeAvailabilityRecord[] {
  const start: RuntimeAvailabilityRecord = {
    event: "started",
    at: session.at,
    sessionId: session.sessionId,
    pid: session.pid,
  };
  const lastStart = [...existing]
    .reverse()
    .find((record) => record.event === "started");
  if (lastStart === undefined) return [start];
  const closed = existing.some(
    (record) =>
      (record.event === "stopped" || record.event === "lost") &&
      record.sessionId === lastStart.sessionId,
  );
  if (closed) return [start];
  return [
    {
      event: "lost",
      // Only a heartbeat from that same session can vouch for when it was last
      // alive. Falling back to its start time would report an outage shorter
      // than it was, which is the one direction that must not happen.
      at: heartbeat?.sessionId === lastStart.sessionId ? heartbeat.at : null,
      sessionId: lastStart.sessionId,
    },
    start,
  ];
}

/** Turns the record into alternating up/down spans, ending at `now`. */
export function availabilitySpans(
  records: readonly RuntimeAvailabilityRecord[],
  now: string,
): AvailabilitySpan[] {
  const spans: AvailabilitySpan[] = [];
  let upFrom: string | null | undefined;
  let downFrom: string | null | undefined;

  for (const record of records) {
    if (record.event === "started") {
      if (downFrom !== undefined) {
        spans.push({ state: "down", from: downFrom, to: record.at });
        downFrom = undefined;
      } else if (upFrom !== undefined) {
        // A start while already up can only mean the record lost the close.
        // Ending the previous span at an unknown boundary keeps the anomaly
        // visible; dropping it would quietly under-report uptime instead.
        spans.push({ state: "up", from: upFrom, to: null });
      }
      upFrom = record.at;
      continue;
    }
    if (upFrom !== undefined) {
      spans.push({ state: "up", from: upFrom, to: record.at });
      upFrom = undefined;
    }
    downFrom = record.at;
  }

  if (upFrom !== undefined) spans.push({ state: "up", from: upFrom, to: now });
  if (downFrom !== undefined) spans.push({ state: "down", from: downFrom, to: now });
  return spans;
}

export function parseAvailabilityRecords(
  contents: string,
): RuntimeAvailabilityRecord[] {
  const records: RuntimeAvailabilityRecord[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      // A truncated final line is expected after a hard kill and is not a
      // reason to discard everything written before it.
      records.push(JSON.parse(trimmed) as RuntimeAvailabilityRecord);
    } catch {
      continue;
    }
  }
  return records;
}

export interface RuntimeAvailabilityRecorder {
  readonly sessionId: string;
  beat(at: string): void;
  stop(at: string): void;
}

/**
 * Writes synchronously on purpose. These are a handful of small writes an hour,
 * and a heartbeat queued behind an event loop that is about to stop existing is
 * a heartbeat that never happened.
 */
export function createRuntimeAvailabilityRecorder(options: {
  readonly logPath: string;
  readonly heartbeatPath: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly at: string;
}): RuntimeAvailabilityRecorder {
  mkdirSync(dirname(options.logPath), { recursive: true });
  let heartbeat: RuntimeHeartbeat | undefined;
  try {
    heartbeat = JSON.parse(
      readFileSync(options.heartbeatPath, "utf8"),
    ) as RuntimeHeartbeat;
  } catch {
    heartbeat = undefined;
  }
  let existing: RuntimeAvailabilityRecord[] = [];
  try {
    existing = parseAvailabilityRecords(readFileSync(options.logPath, "utf8"));
  } catch {
    existing = [];
  }

  const append = (records: readonly RuntimeAvailabilityRecord[]): void => {
    appendFileSync(
      options.logPath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
  };

  append(startupRecords(heartbeat, existing, {
    at: options.at,
    sessionId: options.sessionId,
    pid: options.pid,
  }));

  const writeHeartbeat = (at: string): void => {
    writeFileSync(
      options.heartbeatPath,
      JSON.stringify({ at, sessionId: options.sessionId, pid: options.pid }),
      "utf8",
    );
  };
  writeHeartbeat(options.at);

  let stopped = false;
  return {
    sessionId: options.sessionId,
    beat: (at) => {
      if (!stopped) writeHeartbeat(at);
    },
    stop: (at) => {
      if (stopped) return;
      stopped = true;
      writeHeartbeat(at);
      append([{ event: "stopped", at, sessionId: options.sessionId }]);
    },
  };
}
