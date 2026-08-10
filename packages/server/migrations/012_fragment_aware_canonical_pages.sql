CREATE TABLE migration_012_fragment_variants (
  old_tab_id INTEGER NOT NULL,
  browser TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  window_id INTEGER NOT NULL,
  tab_index INTEGER NOT NULL,
  favicon_url TEXT,
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  new_tab_id INTEGER,
  PRIMARY KEY (old_tab_id, url_normalized)
);

WITH variant_sources AS (
  SELECT
    tab_instances.tab_id AS old_tab_id,
    tabs.browser,
    tabhub_normalize_url_v2(tab_instances.url) AS url_normalized,
    tab_instances.url,
    tab_instances.title,
    tab_instances.window_id,
    tab_instances.tab_index,
    tab_instances.favicon_url,
    1 AS is_open,
    tab_instances.first_seen_at,
    tab_instances.last_seen_at,
    1 AS source_priority,
    tab_instances.id AS source_id
  FROM tab_instances
  JOIN tabs ON tabs.id = tab_instances.tab_id

  UNION ALL

  SELECT
    saved_workspace_items.canonical_tab_id AS old_tab_id,
    saved_workspace_items.browser,
    tabhub_normalize_url_v2(saved_workspace_items.url) AS url_normalized,
    saved_workspace_items.url,
    saved_workspace_items.title,
    saved_workspace_items.window_id,
    saved_workspace_items.tab_index,
    saved_workspace_items.favicon_url,
    0 AS is_open,
    saved_workspaces.created_at AS first_seen_at,
    saved_workspaces.created_at AS last_seen_at,
    0 AS source_priority,
    saved_workspace_items.id AS source_id
  FROM saved_workspace_items
  JOIN saved_workspaces
    ON saved_workspaces.id = saved_workspace_items.workspace_id
  JOIN tabs ON tabs.id = saved_workspace_items.canonical_tab_id
  WHERE saved_workspace_items.canonical_tab_id IS NOT NULL
),
ranked_instances AS (
  SELECT
    old_tab_id,
    browser,
    url_normalized,
    url,
    title,
    window_id,
    tab_index,
    favicon_url,
    MAX(is_open) OVER (
      PARTITION BY old_tab_id, url_normalized
    ) AS is_open,
    COALESCE(
      MIN(CASE WHEN is_open = 1 THEN first_seen_at END) OVER (
        PARTITION BY old_tab_id, url_normalized
      ),
      MIN(first_seen_at) OVER (
        PARTITION BY old_tab_id, url_normalized
      )
    ) AS first_seen_at,
    COALESCE(
      MAX(CASE WHEN is_open = 1 THEN last_seen_at END) OVER (
        PARTITION BY old_tab_id, url_normalized
      ),
      MAX(last_seen_at) OVER (
        PARTITION BY old_tab_id, url_normalized
      )
    ) AS last_seen_at,
    ROW_NUMBER() OVER (
      PARTITION BY
        old_tab_id,
        url_normalized
      ORDER BY source_priority DESC, last_seen_at DESC, source_id DESC
    ) AS representative
  FROM variant_sources
)
INSERT INTO migration_012_fragment_variants (
  old_tab_id,
  browser,
  url_normalized,
  url,
  title,
  window_id,
  tab_index,
  favicon_url,
  is_open,
  first_seen_at,
  last_seen_at
)
SELECT
  old_tab_id,
  browser,
  url_normalized,
  url,
  title,
  window_id,
  tab_index,
  favicon_url,
  is_open,
  first_seen_at,
  last_seen_at
FROM ranked_instances
WHERE representative = 1;

UPDATE migration_012_fragment_variants
SET new_tab_id = old_tab_id
WHERE url_normalized = (
  SELECT tabhub_normalize_url_v2(tabs.url)
  FROM tabs
  WHERE tabs.id = migration_012_fragment_variants.old_tab_id
);

CREATE INDEX migration_012_fragment_variants_new_tab_idx
ON migration_012_fragment_variants (new_tab_id);

UPDATE migration_012_fragment_variants
SET new_tab_id = old_tab_id
WHERE rowid IN (
  SELECT candidate.rowid
  FROM migration_012_fragment_variants AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM migration_012_fragment_variants AS reused
    WHERE reused.old_tab_id = candidate.old_tab_id
      AND reused.new_tab_id = candidate.old_tab_id
  )
    AND candidate.rowid = (
      SELECT newest.rowid
      FROM migration_012_fragment_variants AS newest
      WHERE newest.old_tab_id = candidate.old_tab_id
      ORDER BY newest.last_seen_at DESC, newest.rowid DESC
      LIMIT 1
    )
);

UPDATE tabs
SET
  url = (
    SELECT variants.url
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  url_normalized = (
    SELECT variants.url_normalized
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  title = COALESCE(
    (
      SELECT variants.title
      FROM migration_012_fragment_variants AS variants
      WHERE variants.new_tab_id = tabs.id
    ),
    title
  ),
  window_id = (
    SELECT variants.window_id
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  tab_index = (
    SELECT variants.tab_index
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  favicon_url = COALESCE(
    (
      SELECT variants.favicon_url
      FROM migration_012_fragment_variants AS variants
      WHERE variants.new_tab_id = tabs.id
    ),
    favicon_url
  ),
  is_open = (
    SELECT variants.is_open
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  first_seen_at = (
    SELECT variants.first_seen_at
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  last_seen_at = (
    SELECT variants.last_seen_at
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  ),
  closed_at = (
    SELECT CASE
      WHEN variants.is_open = 1 THEN NULL
      ELSE variants.last_seen_at
    END
    FROM migration_012_fragment_variants AS variants
    WHERE variants.new_tab_id = tabs.id
  )
WHERE EXISTS (
  SELECT 1
  FROM migration_012_fragment_variants AS variants
  WHERE variants.new_tab_id = tabs.id
);

UPDATE tabs
SET url_normalized = tabhub_normalize_url_v2(url)
WHERE NOT EXISTS (
  SELECT 1
  FROM migration_012_fragment_variants AS variants
  WHERE variants.old_tab_id = tabs.id
);

INSERT INTO tabs (
  url,
  url_normalized,
  title,
  browser,
  window_id,
  tab_index,
  favicon_url,
  status,
  importance,
  is_open,
  first_seen_at,
  last_seen_at,
  closed_at
)
SELECT
  variants.url,
  variants.url_normalized,
  variants.title,
  variants.browser,
  variants.window_id,
  variants.tab_index,
  variants.favicon_url,
  source.status,
  source.importance,
  variants.is_open,
  variants.first_seen_at,
  variants.last_seen_at,
  CASE
    WHEN variants.is_open = 1 THEN NULL
    ELSE variants.last_seen_at
  END
FROM migration_012_fragment_variants AS variants
JOIN tabs AS source ON source.id = variants.old_tab_id
WHERE variants.new_tab_id IS NULL;

UPDATE migration_012_fragment_variants
SET new_tab_id = (
  SELECT tabs.id
  FROM tabs
  WHERE tabs.browser = migration_012_fragment_variants.browser
    AND tabs.url_normalized = migration_012_fragment_variants.url_normalized
)
WHERE new_tab_id IS NULL;

INSERT OR IGNORE INTO tab_tags (tab_id, tag_id, assigned_by)
SELECT
  variants.new_tab_id,
  tab_tags.tag_id,
  tab_tags.assigned_by
FROM migration_012_fragment_variants AS variants
JOIN tab_tags ON tab_tags.tab_id = variants.old_tab_id
WHERE variants.new_tab_id != variants.old_tab_id;

INSERT OR IGNORE INTO custom_fields (tab_id, key, value)
SELECT
  variants.new_tab_id,
  custom_fields.key,
  custom_fields.value
FROM migration_012_fragment_variants AS variants
JOIN custom_fields ON custom_fields.tab_id = variants.old_tab_id
WHERE variants.new_tab_id != variants.old_tab_id;

UPDATE tab_instances
SET tab_id = (
  SELECT variants.new_tab_id
  FROM migration_012_fragment_variants AS variants
  WHERE variants.old_tab_id = tab_instances.tab_id
    AND variants.url_normalized = tabhub_normalize_url_v2(tab_instances.url)
)
WHERE EXISTS (
  SELECT 1
  FROM migration_012_fragment_variants AS variants
  WHERE variants.old_tab_id = tab_instances.tab_id
    AND variants.url_normalized = tabhub_normalize_url_v2(tab_instances.url)
);

UPDATE saved_workspace_items
SET canonical_tab_id = (
  SELECT tabs.id
  FROM tabs
  WHERE tabs.browser = saved_workspace_items.browser
    AND tabs.url_normalized = tabhub_normalize_url_v2(saved_workspace_items.url)
)
WHERE canonical_tab_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM tabs
    WHERE tabs.browser = saved_workspace_items.browser
      AND tabs.url_normalized = tabhub_normalize_url_v2(saved_workspace_items.url)
  );

DROP TABLE migration_012_fragment_variants;
