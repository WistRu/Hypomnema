CREATE TABLE tabs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  title TEXT,
  browser TEXT NOT NULL,
  window_id INTEGER,
  tab_index INTEGER,
  favicon_url TEXT,
  status TEXT NOT NULL DEFAULT 'inbox'
    CHECK (status IN ('inbox', 'in_progress', 'done', 'archived')),
  importance INTEGER NOT NULL DEFAULT 0
    CHECK (importance BETWEEN 0 AND 3),
  is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (url_normalized, browser)
);

CREATE INDEX tabs_browser_open_idx ON tabs (browser, is_open);
CREATE INDEX tabs_status_idx ON tabs (status);
CREATE INDEX tabs_last_seen_idx ON tabs (last_seen_at DESC);

CREATE TABLE contents (
  tab_id INTEGER PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  text TEXT,
  html_excerpt TEXT,
  summary TEXT,
  summary_model TEXT,
  extracted_at TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  color TEXT,
  UNIQUE (name, parent_id)
);

CREATE TABLE tab_tags (
  tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL CHECK (assigned_by IN ('user', 'agent')),
  PRIMARY KEY (tab_id, tag_id)
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  from_tab INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  to_tab INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'related',
  note TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  CHECK (from_tab != to_tab)
);

CREATE INDEX links_from_tab_idx ON links (from_tab);
CREATE INDEX links_to_tab_idx ON links (to_tab);

CREATE TABLE custom_fields (
  tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (tab_id, key)
);
