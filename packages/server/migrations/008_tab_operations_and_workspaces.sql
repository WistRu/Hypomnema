ALTER TABLE tab_instances
ADD COLUMN audible INTEGER NOT NULL DEFAULT 0 CHECK (audible IN (0, 1));

ALTER TABLE tab_instances
ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1));

ALTER TABLE tab_instances
ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0 CHECK (discarded IN (0, 1));

CREATE TABLE saved_workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (
    length(trim(name)) BETWEEN 1 AND 200
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX saved_workspaces_updated_idx
ON saved_workspaces (updated_at DESC, id DESC);

CREATE TABLE saved_workspace_items (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL
    REFERENCES saved_workspaces(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_instance_id INTEGER NOT NULL CHECK (source_instance_id > 0),
  canonical_tab_id INTEGER REFERENCES tabs(id) ON DELETE SET NULL,
  browser TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  browser_session_id TEXT,
  browser_tab_id INTEGER CHECK (
    browser_tab_id IS NULL OR browser_tab_id >= 0
  ),
  url TEXT NOT NULL,
  title TEXT,
  window_id INTEGER NOT NULL,
  tab_index INTEGER NOT NULL CHECK (tab_index >= 0),
  favicon_url TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  audible INTEGER NOT NULL CHECK (audible IN (0, 1)),
  muted INTEGER NOT NULL CHECK (muted IN (0, 1)),
  discarded INTEGER NOT NULL CHECK (discarded IN (0, 1)),
  last_accessed REAL CHECK (last_accessed IS NULL OR last_accessed >= 0),
  UNIQUE (workspace_id, ordinal)
);
