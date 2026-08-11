import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  IngestActivity,
  IngestActivityResponse,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";

interface ActivityStreamCursorRow {
  last_event_id: string;
  last_payload_digest: string;
  last_sequence: number;
}

export interface ActivityCatalog {
  ingestActivity(activity: IngestActivity): IngestActivityResponse;
}

export class ActivityEventConflictError extends Error {
  readonly code = "ACTIVITY_EVENT_CONFLICT";

  constructor(readonly eventId: string) {
    super(`Activity event ${eventId} was already used for different data`);
    this.name = "ActivityEventConflictError";
  }
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
  clock: () => Date = () => new Date(),
): ActivityCatalog {
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

  const ingest = connection.transaction(
    (activity: IngestActivity): IngestActivityResponse => {
      const cursor = selectCursor.get(
        activity.installationId,
        activity.browserSessionId,
      ) as ActivityStreamCursorRow | undefined;
      const payloadDigest = activityPayloadDigest(activity);

      if (cursor !== undefined) {
        if (activity.sequence < cursor.last_sequence) {
          return { accepted: false };
        }

        if (activity.sequence === cursor.last_sequence) {
          if (
            activity.id === cursor.last_event_id &&
            payloadDigest === cursor.last_payload_digest
          ) {
            return { accepted: false };
          }
          throw new ActivityEventConflictError(activity.id);
        }
      }

      const updatedAt = clock().toISOString();
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
        urlNormalized: normalizeUrl(activity.url),
      });
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

  return {
    ingestActivity(activity) {
      return ingest(activity);
    },
  };
}
