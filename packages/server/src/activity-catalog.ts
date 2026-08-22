import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  ActivityIngestMetricsResponse,
  ActivityRollup,
  ActivityWindow,
  IngestActivity,
  IngestActivityResponse,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";
import type { LogicalPageCatalog } from "./logical-page-catalog.js";

interface ActivityStreamCursorRow {
  last_event_id: string;
  last_payload_digest: string;
  last_sequence: number;
}

interface ActivityDailyWriterStateRow {
  coverage_started_at: string | null;
  state: string;
  updated_at: string;
}

export interface ActivityCatalog {
  ingestActivity(activity: IngestActivity): IngestActivityResponse;
  metrics(): ActivityIngestMetricsResponse;
  pageActivity(logicalPageId: number, window: ActivityWindow): ActivityRollup | undefined;
  resourceActivity(resourceId: number, window: ActivityWindow): ActivityRollup | undefined;
}

export class ActivityEventConflictError extends Error {
  readonly code = "ACTIVITY_EVENT_CONFLICT";

  constructor(readonly eventId: string) {
    super(`Activity event ${eventId} was already used for different data`);
    this.name = "ActivityEventConflictError";
  }
}

export class ActivityEventInFutureError extends Error {
  readonly code = "ACTIVITY_EVENT_IN_FUTURE";

  constructor(readonly eventId: string) {
    super(`Activity event ${eventId} ends after the server clock`);
    this.name = "ActivityEventInFutureError";
  }
}

export class ActivityDailyWriterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityDailyWriterStateError";
  }
}

export interface ActivityCatalogOptions {
  readonly dailyWriterEnabled?: boolean;
}

interface DailyAllocation {
  activityDate: string;
  foregroundMs: number;
  engagedMs: number;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnight(timestamp: number): number {
  const value = new Date(timestamp);
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate() + 1,
  );
}

function proportionalFloors(total: number, overlaps: readonly number[]): number[] {
  const duration = overlaps.reduce((sum, overlap) => sum + overlap, 0);
  return overlaps.map((overlap) =>
    Number((BigInt(total) * BigInt(overlap)) / BigInt(duration)),
  );
}

/** Split one accepted aggregate interval into exact, invariant-safe UTC buckets. */
export function splitActivityByUtcDate(activity: IngestActivity): DailyAllocation[] {
  const startedAt = Date.parse(activity.startedAt);
  const endedAt = Date.parse(activity.endedAt);
  const segments: Array<{ activityDate: string; overlapMs: number }> = [];
  let cursor = startedAt;
  while (cursor < endedAt) {
    const segmentEnd = Math.min(endedAt, nextUtcMidnight(cursor));
    segments.push({
      activityDate: utcDate(new Date(cursor)),
      overlapMs: segmentEnd - cursor,
    });
    cursor = segmentEnd;
  }
  const overlaps = segments.map(({ overlapMs }) => overlapMs);
  const foreground = proportionalFloors(activity.foregroundMs, overlaps);
  foreground[foreground.length - 1]! +=
    activity.foregroundMs - foreground.reduce((sum, value) => sum + value, 0);

  const engaged = proportionalFloors(activity.engagedMs, overlaps);
  let engagedRemainder =
    activity.engagedMs - engaged.reduce((sum, value) => sum + value, 0);
  for (let index = engaged.length - 1; index >= 0 && engagedRemainder > 0; index -= 1) {
    const capacity = foreground[index]! - engaged[index]!;
    const allocated = Math.min(capacity, engagedRemainder);
    engaged[index]! += allocated;
    engagedRemainder -= allocated;
  }
  if (engagedRemainder !== 0) {
    throw new Error("Unable to preserve engaged activity across UTC buckets");
  }
  return segments.map(({ activityDate }, index) => ({
    activityDate,
    foregroundMs: foreground[index]!,
    engagedMs: engaged[index]!,
  }));
}

function clipActivityToCoverage(
  activity: IngestActivity,
  coverageStartedAt: string,
): IngestActivity | undefined {
  const startedAt = Date.parse(activity.startedAt);
  const endedAt = Date.parse(activity.endedAt);
  const coverage = Date.parse(coverageStartedAt);
  if (endedAt <= coverage) return undefined;
  if (startedAt >= coverage) return activity;

  const fullDuration = endedAt - startedAt;
  const suffixDuration = endedAt - coverage;
  return {
    ...activity,
    startedAt: coverageStartedAt,
    foregroundMs: Number(
      (BigInt(activity.foregroundMs) * BigInt(suffixDuration)) /
        BigInt(fullDuration),
    ),
    engagedMs: Number(
      (BigInt(activity.engagedMs) * BigInt(suffixDuration)) /
        BigInt(fullDuration),
    ),
  };
}

function activityPayloadDigest(activity: IngestActivity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        activity.id,
        activity.browser,
        activity.installationId,
        activity.browserSessionId,
        activity.browserTabId,
        activity.sequence,
        activity.url,
        activity.startedAt,
        activity.endedAt,
        activity.foregroundMs,
        activity.engagedMs,
      ]),
    )
    .digest("hex");
}

export function createActivityCatalog(
  connection: Database.Database,
  logicalPageCatalog: LogicalPageCatalog,
  clock: () => Date = () => new Date(),
  options: ActivityCatalogOptions = {},
): ActivityCatalog {
  const dailyWriterEnabled = options.dailyWriterEnabled === true;
  const dailySchemaAvailable = connection.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'activity_daily_writer_state'
  `).pluck().get() === 1;
  if (!dailySchemaAvailable) {
    if (dailyWriterEnabled) {
      throw new ActivityDailyWriterStateError(
        "Activity daily writer schema is unavailable",
      );
    }
    const selectLogicalPage = connection.prepare(
      "SELECT id FROM logical_pages WHERE id = ?",
    );
    const selectResource = connection.prepare(
      "SELECT id FROM resources WHERE id = ?",
    );
    const allRollup = (
      subject: "page" | "resource",
      id: number,
    ): ActivityRollup => {
      const membership = `
        SELECT assignments.logical_page_id
        FROM logical_page_resource_heads AS heads
        JOIN logical_page_resource_assignments AS assignments
          ON assignments.id = heads.assignment_id
        WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
      `;
      const row = connection.prepare(`
        SELECT COALESCE(SUM(activity.foreground_ms), 0) AS foreground_ms,
          COALESCE(SUM(activity.engaged_ms), 0) AS engaged_ms,
          MIN(activity.first_activity_at) AS coverage_start
        FROM tab_page_activity_totals AS activity
        JOIN logical_pages
          ON logical_pages.url_normalized = activity.url_normalized
        WHERE logical_pages.id ${subject === "page" ? "= ?" : `IN (${membership})`}
      `).get(id) as {
        coverage_start: string | null;
        engaged_ms: number;
        foreground_ms: number;
      };
      return {
        window: "all",
        onScreenMs: row.foreground_ms,
        activeUseMs: row.engaged_ms,
        coverageStart: row.coverage_start,
        windowStart: row.coverage_start,
        windowEnd: clock().toISOString(),
      };
    };
    return {
      ingestActivity() {
        throw new ActivityDailyWriterStateError(
          "Historical activity baseline is read-only",
        );
      },
      metrics() {
        return {
          duplicateEvents: 0,
          outOfOrderRejections: 0,
          gapEvents: 0,
          missingSequences: 0,
          updatedAt: clock().toISOString(),
        };
      },
      pageActivity(logicalPageId, window) {
        if (selectLogicalPage.get(logicalPageId) === undefined) return undefined;
        if (window !== "all") {
          throw new ActivityDailyWriterStateError(
            "Historical activity baseline has no daily windows",
          );
        }
        return allRollup("page", logicalPageId);
      },
      resourceActivity(resourceId, window) {
        if (selectResource.get(resourceId) === undefined) return undefined;
        if (window !== "all") {
          throw new ActivityDailyWriterStateError(
            "Historical activity baseline has no daily windows",
          );
        }
        return allRollup("resource", resourceId);
      },
    };
  }
  const selectWriterState = connection.prepare(`
    SELECT state, coverage_started_at, updated_at
    FROM activity_daily_writer_state
    WHERE singleton_id = 1
  `);
  const selectAvailabilityEpoch = connection.prepare(`
    SELECT coverage_started_at
    FROM activity_tracking_epochs
    WHERE metric = 'logical_page_activity_daily'
  `);
  const enableWriter = connection.prepare(`
    UPDATE activity_daily_writer_state
    SET state = 'enabled', coverage_started_at = ?, updated_at = ?
    WHERE singleton_id = 1 AND state = 'disabled'
      AND coverage_started_at IS NULL AND updated_at = ?
  `);
  const disableWriter = connection.prepare(`
    UPDATE activity_daily_writer_state
    SET state = 'disabled', coverage_started_at = NULL, updated_at = ?
    WHERE singleton_id = 1 AND state = 'enabled'
      AND coverage_started_at = ? AND updated_at = ?
  `);
  const purgeDailyFromDate = connection.prepare(`
    DELETE FROM logical_page_activity_daily WHERE activity_date >= ?
  `);

  const validatedAvailabilityEpoch = (): string => {
    const availability = selectAvailabilityEpoch.pluck().get() as string | undefined;
    if (availability === undefined || !Number.isFinite(Date.parse(availability))) {
      throw new ActivityDailyWriterStateError("Invalid activity availability epoch");
    }
    return availability;
  };

  const validatedWriterState = (): ActivityDailyWriterStateRow => {
    const row = selectWriterState.get() as ActivityDailyWriterStateRow | undefined;
    const availability = validatedAvailabilityEpoch();
    if (
      row === undefined ||
      !["disabled", "enabled"].includes(row.state) ||
      (row.state === "disabled" && row.coverage_started_at !== null) ||
      (row.state === "enabled" && row.coverage_started_at === null) ||
      !Number.isFinite(Date.parse(row.updated_at)) ||
      (row.coverage_started_at !== null &&
        !Number.isFinite(Date.parse(row.coverage_started_at)))
    ) {
      throw new ActivityDailyWriterStateError("Invalid activity daily writer state");
    }
    if (
      row.state === "enabled" &&
      (row.coverage_started_at !== row.updated_at ||
        Date.parse(row.coverage_started_at!) < Date.parse(availability))
    ) {
      throw new ActivityDailyWriterStateError(
        "Inconsistent activity daily writer coverage",
      );
    }
    return row;
  };

  const assertWriterClock = (
    currentTimestamp: string,
    state: ActivityDailyWriterStateRow,
  ): void => {
    if (Date.parse(currentTimestamp) < Date.parse(state.updated_at)) {
      throw new ActivityDailyWriterStateError("Activity daily writer clock regressed");
    }
  };

  connection.transaction(() => {
    const state = validatedWriterState();
    if (state.state === (dailyWriterEnabled ? "enabled" : "disabled")) {
      if (dailyWriterEnabled) assertWriterClock(clock().toISOString(), state);
      return;
    }

    const now = clock().toISOString();
    assertWriterClock(now, state);
    if (dailyWriterEnabled) {
      const availability = validatedAvailabilityEpoch();
      const coverageStartedAt =
        Date.parse(now) >= Date.parse(availability) ? now : availability;
      if (enableWriter.run(coverageStartedAt, coverageStartedAt, state.updated_at).changes !== 1) {
        throw new ActivityDailyWriterStateError("Activity writer state changed concurrently");
      }
      purgeDailyFromDate.run(utcDate(new Date(coverageStartedAt)));
      return;
    }

    if (disableWriter.run(now, state.coverage_started_at, state.updated_at).changes !== 1) {
      throw new ActivityDailyWriterStateError("Activity writer state changed concurrently");
    }
  }).immediate();

  const currentWriterCoverage = (currentTimestamp: string): string | undefined => {
    if (!dailyWriterEnabled) return undefined;
    const state = validatedWriterState();
    assertWriterClock(currentTimestamp, state);
    return state.state === "enabled" ? state.coverage_started_at! : undefined;
  };
  const selectCursor = connection.prepare(`
    SELECT last_sequence, last_event_id, last_payload_digest
    FROM tab_activity_stream_cursors
    WHERE installation_id = ? AND browser_session_id = ?
  `);
  const incrementTotals = connection.prepare(`
    INSERT INTO tab_activity_totals (
      installation_id,
      browser_session_id,
      browser_tab_id,
      foreground_ms,
      engaged_ms,
      updated_at
    ) VALUES (
      @installationId,
      @browserSessionId,
      @browserTabId,
      @foregroundMs,
      @engagedMs,
      @updatedAt
    )
    ON CONFLICT (
      installation_id,
      browser_session_id,
      browser_tab_id
    ) DO UPDATE SET
      foreground_ms = tab_activity_totals.foreground_ms + excluded.foreground_ms,
      engaged_ms = tab_activity_totals.engaged_ms + excluded.engaged_ms,
      updated_at = excluded.updated_at
  `);
  const ensurePageRecord = connection.prepare(`
    INSERT INTO tabs (
      url,
      url_normalized,
      title,
      browser,
      window_id,
      tab_index,
      favicon_url,
      logical_page_id,
      is_open,
      first_seen_at,
      last_seen_at,
      closed_at
    ) VALUES (
      @url,
      @urlNormalized,
      NULL,
      @browser,
      NULL,
      NULL,
      NULL,
      @logicalPageId,
      0,
      @firstSeenAt,
      @lastSeenAt,
      @closedAt
    )
    ON CONFLICT (url_normalized, browser) DO UPDATE SET
      url = CASE
        WHEN excluded.last_seen_at >= tabs.last_seen_at THEN excluded.url
        ELSE tabs.url
      END,
      logical_page_id = excluded.logical_page_id,
      first_seen_at = MIN(tabs.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(tabs.last_seen_at, excluded.last_seen_at),
      closed_at = CASE
        WHEN tabs.is_open = 1 THEN NULL
        WHEN tabs.closed_at IS NULL THEN excluded.closed_at
        ELSE MAX(tabs.closed_at, excluded.closed_at)
      END
  `);
  const incrementPageTotals = connection.prepare(`
    INSERT INTO tab_page_activity_totals (
      browser,
      url_normalized,
      url,
      foreground_ms,
      engaged_ms,
      first_activity_at,
      last_activity_at,
      updated_at
    ) VALUES (
      @browser,
      @urlNormalized,
      @url,
      @foregroundMs,
      @engagedMs,
      @firstActivityAt,
      @lastActivityAt,
      @updatedAt
    )
    ON CONFLICT (browser, url_normalized) DO UPDATE SET
      url = CASE
        WHEN excluded.last_activity_at >= tab_page_activity_totals.last_activity_at
          THEN excluded.url
        ELSE tab_page_activity_totals.url
      END,
      foreground_ms =
        tab_page_activity_totals.foreground_ms + excluded.foreground_ms,
      engaged_ms =
        tab_page_activity_totals.engaged_ms + excluded.engaged_ms,
      first_activity_at = MIN(
        tab_page_activity_totals.first_activity_at,
        excluded.first_activity_at
      ),
      last_activity_at = MAX(
        tab_page_activity_totals.last_activity_at,
        excluded.last_activity_at
      ),
      updated_at = MAX(tab_page_activity_totals.updated_at, excluded.updated_at)
  `);
  const advanceCursor = connection.prepare(`
    INSERT INTO tab_activity_stream_cursors (
      installation_id,
      browser_session_id,
      last_sequence,
      last_event_id,
      last_payload_digest,
      updated_at
    ) VALUES (
      @installationId,
      @browserSessionId,
      @lastSequence,
      @lastEventId,
      @lastPayloadDigest,
      @updatedAt
    )
    ON CONFLICT (installation_id, browser_session_id) DO UPDATE SET
      last_sequence = excluded.last_sequence,
      last_event_id = excluded.last_event_id,
      last_payload_digest = excluded.last_payload_digest,
      updated_at = excluded.updated_at
  `);
  const incrementDaily = connection.prepare(`
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (
      @logicalPageId, @activityDate, @foregroundMs, @engagedMs, @updatedAt
    )
    ON CONFLICT (logical_page_id, activity_date) DO UPDATE SET
      foreground_ms = logical_page_activity_daily.foreground_ms + excluded.foreground_ms,
      engaged_ms = logical_page_activity_daily.engaged_ms + excluded.engaged_ms,
      updated_at = excluded.updated_at
  `);
  const incrementDuplicateMetric = connection.prepare(`
    UPDATE activity_ingest_metrics
    SET duplicate_events = duplicate_events + 1, updated_at = ?
    WHERE singleton_id = 1
  `);
  const incrementOutOfOrderMetric = connection.prepare(`
    UPDATE activity_ingest_metrics
    SET out_of_order_rejections = out_of_order_rejections + 1, updated_at = ?
    WHERE singleton_id = 1
  `);
  const incrementGapMetric = connection.prepare(`
    UPDATE activity_ingest_metrics
    SET gap_events = gap_events + 1,
      missing_sequences = missing_sequences + ?, updated_at = ?
    WHERE singleton_id = 1
  `);
  const selectMetrics = connection.prepare(`
    SELECT duplicate_events, out_of_order_rejections, gap_events,
      missing_sequences, updated_at
    FROM activity_ingest_metrics WHERE singleton_id = 1
  `);
  const selectLogicalPage = connection.prepare(
    "SELECT id FROM logical_pages WHERE id = ?",
  );
  const selectResource = connection.prepare(
    "SELECT id FROM resources WHERE id = ?",
  );

  const ingest = connection.transaction(
    (activity: IngestActivity): IngestActivityResponse => {
      const updatedAt = clock().toISOString();
      if (Date.parse(activity.endedAt) > Date.parse(updatedAt)) {
        throw new ActivityEventInFutureError(activity.id);
      }
      const cursor = selectCursor.get(
        activity.installationId,
        activity.browserSessionId,
      ) as ActivityStreamCursorRow | undefined;
      const payloadDigest = activityPayloadDigest(activity);
      const writerCoverageStartedAt = currentWriterCoverage(updatedAt);

      if (cursor !== undefined) {
        if (activity.sequence < cursor.last_sequence) {
          if (writerCoverageStartedAt !== undefined) incrementOutOfOrderMetric.run(updatedAt);
          return { accepted: false };
        }

        if (activity.sequence === cursor.last_sequence) {
          if (
            activity.id === cursor.last_event_id &&
            payloadDigest === cursor.last_payload_digest
          ) {
            if (writerCoverageStartedAt !== undefined) incrementDuplicateMetric.run(updatedAt);
            return { accepted: false };
          }
          throw new ActivityEventConflictError(activity.id);
        }
      }

      const urlNormalized = normalizeUrl(activity.url);
      const logicalPage = logicalPageCatalog.resolve({
        firstObservedAt: activity.startedAt,
        observedAt: activity.endedAt,
        url: activity.url,
        urlNormalized,
      });
      ensurePageRecord.run({
        browser: activity.browser,
        closedAt: activity.endedAt,
        firstSeenAt: activity.startedAt,
        lastSeenAt: activity.endedAt,
        logicalPageId: logicalPage.id,
        url: activity.url,
        urlNormalized,
      });
      incrementTotals.run({
        browserSessionId: activity.browserSessionId,
        browserTabId: activity.browserTabId,
        engagedMs: activity.engagedMs,
        foregroundMs: activity.foregroundMs,
        installationId: activity.installationId,
        updatedAt,
      });
      incrementPageTotals.run({
        browser: activity.browser,
        engagedMs: activity.engagedMs,
        firstActivityAt: activity.startedAt,
        foregroundMs: activity.foregroundMs,
        lastActivityAt: activity.endedAt,
        updatedAt,
        url: activity.url,
        urlNormalized,
      });
      if (writerCoverageStartedAt !== undefined) {
        const coveredActivity = clipActivityToCoverage(activity, writerCoverageStartedAt);
        for (const allocation of coveredActivity === undefined
          ? []
          : splitActivityByUtcDate(coveredActivity)) {
          incrementDaily.run({
            ...allocation,
            logicalPageId: logicalPage.id,
            updatedAt,
          });
        }
      }
      if (
        writerCoverageStartedAt !== undefined &&
        cursor !== undefined &&
        activity.sequence > cursor.last_sequence + 1
      ) {
        incrementGapMetric.run(
          activity.sequence - cursor.last_sequence - 1,
          updatedAt,
        );
      }
      advanceCursor.run({
        browserSessionId: activity.browserSessionId,
        installationId: activity.installationId,
        lastEventId: activity.id,
        lastPayloadDigest: payloadDigest,
        lastSequence: activity.sequence,
        updatedAt,
      });
      return { accepted: true };
    },
  );

  const calendarBounds = (window: "7d" | "30d") => {
    const now = clock();
    const days = window === "7d" ? 7 : 30;
    const start = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (days - 1),
    ));
    const end = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    ));
    return { now, start, end };
  };
  const dailyRollup = (
    subject: "page" | "resource",
    id: number,
    window: "7d" | "30d",
  ): ActivityRollup => {
    const { now, start, end } = calendarBounds(window);
    const membership = `
      SELECT assignments.logical_page_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
      WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    `;
    const writerState = validatedWriterState();
    if (writerState.state !== "enabled") {
      throw new ActivityDailyWriterStateError("Activity daily writer is disabled");
    }
    assertWriterClock(now.toISOString(), writerState);
    const coverageStart = writerState.coverage_started_at!;
    const lowerDate = utcDate(start) >= utcDate(new Date(coverageStart))
      ? utcDate(start)
      : utcDate(new Date(coverageStart));
    const boundedRow = connection.prepare(`
      SELECT COALESCE(SUM(foreground_ms), 0) AS foreground_ms,
        COALESCE(SUM(engaged_ms), 0) AS engaged_ms
      FROM logical_page_activity_daily
      WHERE logical_page_id ${subject === "page" ? "= ?" : `IN (${membership})`}
        AND activity_date >= ? AND activity_date < ?
    `).get(id, lowerDate, utcDate(end)) as {
      engaged_ms: number;
      foreground_ms: number;
    };
    return {
      window,
      onScreenMs: boundedRow.foreground_ms,
      activeUseMs: boundedRow.engaged_ms,
      coverageStart,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
    };
  };
  const allRollup = (
    subject: "page" | "resource",
    id: number,
  ): ActivityRollup => {
    const membership = `
      SELECT assignments.logical_page_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
      WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    `;
    const row = connection.prepare(`
      SELECT COALESCE(SUM(activity.foreground_ms), 0) AS foreground_ms,
        COALESCE(SUM(activity.engaged_ms), 0) AS engaged_ms,
        MIN(activity.first_activity_at) AS coverage_start
      FROM tab_page_activity_totals AS activity
      JOIN logical_pages ON logical_pages.url_normalized = activity.url_normalized
      WHERE logical_pages.id ${subject === "page" ? "= ?" : `IN (${membership})`}
    `).get(id) as {
      coverage_start: string | null;
      engaged_ms: number;
      foreground_ms: number;
    };
    return {
      window: "all",
      onScreenMs: row.foreground_ms,
      activeUseMs: row.engaged_ms,
      coverageStart: row.coverage_start,
      windowStart: row.coverage_start,
      windowEnd: clock().toISOString(),
    };
  };

  return {
    ingestActivity(activity) {
      return ingest(activity);
    },
    metrics() {
      currentWriterCoverage(clock().toISOString());
      const row = selectMetrics.get() as {
        duplicate_events: number;
        gap_events: number;
        missing_sequences: number;
        out_of_order_rejections: number;
        updated_at: string;
      };
      return {
        duplicateEvents: row.duplicate_events,
        outOfOrderRejections: row.out_of_order_rejections,
        gapEvents: row.gap_events,
        missingSequences: row.missing_sequences,
        updatedAt: row.updated_at,
      };
    },
    pageActivity(logicalPageId, window) {
      if (selectLogicalPage.get(logicalPageId) === undefined) return undefined;
      return window === "all"
        ? allRollup("page", logicalPageId)
        : dailyRollup("page", logicalPageId, window);
    },
    resourceActivity(resourceId, window) {
      if (selectResource.get(resourceId) === undefined) return undefined;
      return window === "all"
        ? allRollup("resource", resourceId)
        : dailyRollup("resource", resourceId, window);
    },
  };
}
