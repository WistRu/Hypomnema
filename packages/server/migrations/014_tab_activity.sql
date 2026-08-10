CREATE TABLE tab_activity_totals (
  installation_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  browser_tab_id INTEGER NOT NULL CHECK (browser_tab_id >= 0),
  foreground_ms INTEGER NOT NULL CHECK (foreground_ms >= 0),
  engaged_ms INTEGER NOT NULL CHECK (
    engaged_ms >= 0 AND engaged_ms <= foreground_ms
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    installation_id,
    browser_session_id,
    browser_tab_id
  )
);

CREATE TABLE tab_activity_stream_cursors (
  installation_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
  last_event_id TEXT NOT NULL,
  last_payload_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, browser_session_id)
);
