WITH
  ranked_roots AS (
    SELECT
      id,
      ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS occurrence
    FROM tags
    WHERE parent_id IS NULL
  ),
  root_name_bound(max_length) AS MATERIALIZED (
    SELECT COALESCE(MAX(LENGTH(name)), 0)
    FROM tags
    WHERE parent_id IS NULL
  )
UPDATE tags
SET name =
  name ||
  ' [legacy duplicate #' ||
  id ||
  ';' ||
  HEX(ZEROBLOB((SELECT max_length + 1 FROM root_name_bound))) ||
  ']'
WHERE id IN (
  SELECT id
  FROM ranked_roots
  WHERE occurrence > 1
);

CREATE UNIQUE INDEX tags_root_name_unique
ON tags (name)
WHERE parent_id IS NULL;

CREATE INDEX tab_tags_tag_idx ON tab_tags (tag_id, tab_id);
