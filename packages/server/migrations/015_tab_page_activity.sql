CREATE TABLE tab_page_activity_totals (
  browser TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  url TEXT NOT NULL,
  foreground_ms INTEGER NOT NULL CHECK (foreground_ms >= 0),
  engaged_ms INTEGER NOT NULL CHECK (
    engaged_ms >= 0 AND engaged_ms <= foreground_ms
  ),
  first_activity_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (browser, url_normalized)
);

-- Schema 14 totals have no URL history and cannot be attributed safely.
-- Exact per-page tracking therefore starts with newly accepted activity.
