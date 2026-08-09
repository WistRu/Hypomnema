CREATE TABLE tab_instances (
  id INTEGER PRIMARY KEY,
  tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  browser_tab_id INTEGER CHECK (
    browser_tab_id IS NULL OR browser_tab_id >= 0
  ),
  url TEXT NOT NULL,
  title TEXT,
  window_id INTEGER NOT NULL,
  tab_index INTEGER NOT NULL CHECK (tab_index >= 0),
  favicon_url TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  last_accessed REAL CHECK (last_accessed IS NULL OR last_accessed >= 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (installation_id, instance_key)
);

CREATE INDEX tab_instances_tab_idx
ON tab_instances (tab_id);

CREATE INDEX tab_instances_installation_tab_idx
ON tab_instances (installation_id, tab_id);

CREATE INDEX tab_instances_exact_group_idx
ON tab_instances (installation_id, url);

INSERT INTO tab_instances (
  tab_id,
  installation_id,
  instance_key,
  browser_tab_id,
  url,
  title,
  window_id,
  tab_index,
  favicon_url,
  active,
  pinned,
  last_accessed,
  first_seen_at,
  last_seen_at
)
SELECT
  id,
  'legacy:' || browser,
  'canonical:' || id,
  NULL,
  url,
  title,
  COALESCE(window_id, 0),
  COALESCE(tab_index, 0),
  favicon_url,
  0,
  0,
  NULL,
  first_seen_at,
  last_seen_at
FROM tabs
WHERE is_open = 1;
