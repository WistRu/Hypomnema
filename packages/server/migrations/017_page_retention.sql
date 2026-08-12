CREATE TABLE page_retention (
  tab_id INTEGER PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('kept', 'deferred', 'trashed')),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('user', 'agent')),
  decided_at TEXT NOT NULL,
  review_after TEXT,
  trashed_at TEXT,
  purge_at TEXT,
  CHECK (
    (state = 'kept'
      AND review_after IS NULL
      AND trashed_at IS NULL
      AND purge_at IS NULL)
    OR
    (state = 'deferred'
      AND review_after IS NOT NULL
      AND trashed_at IS NULL
      AND purge_at IS NULL)
    OR
    (state = 'trashed'
      AND review_after IS NULL
      AND trashed_at IS NOT NULL
      AND purge_at IS NOT NULL)
  )
);

CREATE INDEX page_retention_review_idx
ON page_retention (state, review_after, tab_id);

CREATE INDEX page_retention_purge_idx
ON page_retention (state, purge_at, tab_id);

CREATE TRIGGER page_retention_cancel_trash_on_reopen
AFTER UPDATE OF is_open ON tabs
WHEN OLD.is_open = 0 AND NEW.is_open = 1
BEGIN
  DELETE FROM page_retention
  WHERE tab_id = NEW.id AND state = 'trashed';
END;
