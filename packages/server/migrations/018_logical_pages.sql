CREATE TABLE logical_pages (
  id INTEGER PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  url_normalized TEXT NOT NULL,
  representative_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (identity_key = url_normalized)
);

ALTER TABLE tabs
ADD COLUMN logical_page_id INTEGER REFERENCES logical_pages(id);

INSERT INTO logical_pages (
  identity_key,
  url_normalized,
  representative_url,
  created_at,
  updated_at
)
SELECT
  source.url_normalized,
  source.url_normalized,
  (
    SELECT candidate.url
    FROM tabs AS candidate
    WHERE candidate.url_normalized = source.url_normalized
    ORDER BY candidate.last_seen_at DESC, candidate.id ASC
    LIMIT 1
  ),
  MIN(source.first_seen_at),
  MAX(source.last_seen_at)
FROM tabs AS source
GROUP BY source.url_normalized
ORDER BY source.url_normalized;

UPDATE tabs
SET logical_page_id = (
  SELECT logical_pages.id
  FROM logical_pages
  WHERE logical_pages.identity_key = tabs.url_normalized
);

CREATE UNIQUE INDEX tabs_id_logical_page_idx
ON tabs (id, logical_page_id);

CREATE INDEX tabs_logical_page_lookup_idx
ON tabs (logical_page_id, id);

CREATE TABLE logical_page_preferences (
  logical_page_id INTEGER PRIMARY KEY
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  user_importance INTEGER CHECK (user_importance BETWEEN 1 AND 3),
  recorded_by TEXT CHECK (recorded_by IN ('user', 'agent')),
  record_method TEXT CHECK (
    record_method IN ('manual', 'on_behalf_of_user')
  ),
  importance_updated_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (
      user_importance IS NULL
      AND recorded_by IS NULL
      AND record_method IS NULL
      AND importance_updated_at IS NULL
    )
    OR
    (
      user_importance IS NOT NULL
      AND user_importance IN (1, 2, 3)
      AND importance_updated_at IS NOT NULL
      AND (
        (recorded_by IS 'user' AND record_method IS 'manual')
        OR
        (
          recorded_by IS 'agent'
          AND record_method IS 'on_behalf_of_user'
        )
      )
    )
  )
);

INSERT INTO logical_page_preferences (
  logical_page_id,
  user_importance,
  recorded_by,
  record_method,
  importance_updated_at,
  updated_at
)
SELECT
  id,
  NULL,
  NULL,
  NULL,
  NULL,
  updated_at
FROM logical_pages
ORDER BY id;

CREATE TABLE logical_page_importance_migration_audit (
  logical_page_id INTEGER PRIMARY KEY
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  legacy_values_json TEXT NOT NULL CHECK (json_valid(legacy_values_json)),
  suggested_value INTEGER CHECK (suggested_value BETWEEN 1 AND 3),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN ('legacy_unknown', 'conflict', 'confirmed')
  ),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

INSERT INTO logical_page_importance_migration_audit (
  logical_page_id,
  legacy_values_json,
  suggested_value,
  resolution_state,
  created_at,
  reviewed_at
)
SELECT
  logical_pages.id,
  (
    SELECT json_group_array(
      json_object(
        'tabId', legacy.tab_id,
        'browser', legacy.browser,
        'value', legacy.importance
      )
    )
    FROM (
      SELECT
        tabs.id AS tab_id,
        tabs.browser,
        tabs.importance
      FROM tabs
      WHERE tabs.logical_page_id = logical_pages.id
      ORDER BY tabs.browser ASC, tabs.id ASC
    ) AS legacy
  ),
  CASE
    WHEN MIN(tabs.importance) = MAX(tabs.importance)
      AND MIN(tabs.importance) BETWEEN 1 AND 3
    THEN MIN(tabs.importance)
    ELSE NULL
  END,
  CASE
    WHEN MIN(tabs.importance) = MAX(tabs.importance)
      AND MIN(tabs.importance) = 0
    THEN 'confirmed'
    WHEN MIN(tabs.importance) = MAX(tabs.importance)
    THEN 'legacy_unknown'
    ELSE 'conflict'
  END,
  logical_pages.updated_at,
  NULL
FROM logical_pages
JOIN tabs ON tabs.logical_page_id = logical_pages.id
GROUP BY logical_pages.id
ORDER BY logical_pages.id;

CREATE TRIGGER tabs_logical_page_required_insert
BEFORE INSERT ON tabs
WHEN
  NEW.logical_page_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM logical_pages
    WHERE logical_pages.id = NEW.logical_page_id
      AND logical_pages.identity_key = NEW.url_normalized
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'tabs.logical_page_id must reference the matching url_normalized'
  );
END;

CREATE TRIGGER tabs_logical_page_required_update
BEFORE UPDATE OF url_normalized, logical_page_id ON tabs
WHEN
  NEW.logical_page_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM logical_pages
    WHERE logical_pages.id = NEW.logical_page_id
      AND logical_pages.identity_key = NEW.url_normalized
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'tabs.logical_page_id must reference the matching url_normalized'
  );
END;
