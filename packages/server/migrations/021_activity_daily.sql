CREATE TABLE logical_page_activity_daily (
  logical_page_id INTEGER NOT NULL
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL CHECK (
    date(activity_date, '+0 days') IS NOT NULL
    AND activity_date = date(activity_date, '+0 days')
  ),
  foreground_ms INTEGER NOT NULL CHECK (foreground_ms >= 0),
  engaged_ms INTEGER NOT NULL CHECK (
    engaged_ms >= 0 AND engaged_ms <= foreground_ms
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (logical_page_id, activity_date)
);

CREATE INDEX logical_page_activity_daily_date_idx
ON logical_page_activity_daily (activity_date, logical_page_id);

CREATE TABLE activity_tracking_epochs (
  metric TEXT PRIMARY KEY CHECK (metric = 'logical_page_activity_daily'),
  coverage_started_at TEXT NOT NULL
);

INSERT INTO activity_tracking_epochs (metric, coverage_started_at)
VALUES (
  'logical_page_activity_daily',
  tabhub_migration_now()
);

CREATE TRIGGER activity_tracking_epochs_immutable_update
BEFORE UPDATE ON activity_tracking_epochs
BEGIN
  SELECT RAISE(ABORT, 'activity tracking epochs are immutable');
END;

CREATE TRIGGER activity_tracking_epochs_immutable_delete
BEFORE DELETE ON activity_tracking_epochs
BEGIN
  SELECT RAISE(ABORT, 'activity tracking epochs are immutable');
END;

CREATE TABLE activity_ingest_metrics (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  duplicate_events INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_events >= 0),
  out_of_order_rejections INTEGER NOT NULL DEFAULT 0
    CHECK (out_of_order_rejections >= 0),
  gap_events INTEGER NOT NULL DEFAULT 0 CHECK (gap_events >= 0),
  missing_sequences INTEGER NOT NULL DEFAULT 0 CHECK (missing_sequences >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO activity_ingest_metrics (singleton_id, updated_at)
VALUES (1, tabhub_migration_now());

CREATE TABLE activity_daily_writer_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  state TEXT NOT NULL CHECK (state IN ('disabled', 'enabled')),
  coverage_started_at TEXT CHECK (
    coverage_started_at IS NULL
    OR (
      julianday(coverage_started_at) IS NOT NULL
      AND coverage_started_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ', coverage_started_at
      )
    )
  ),
  updated_at TEXT NOT NULL CHECK (
    julianday(updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
  ),
  CHECK (
    (state = 'disabled' AND coverage_started_at IS NULL)
    OR
    (state = 'enabled' AND coverage_started_at IS NOT NULL)
  )
);

INSERT INTO activity_daily_writer_state (
  singleton_id, state, coverage_started_at, updated_at
) VALUES (1, 'disabled', NULL, tabhub_migration_now());
