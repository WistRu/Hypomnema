ALTER TABLE tags
ADD COLUMN system_kind TEXT
CHECK (system_kind IS NULL OR system_kind = 'untagged');

WITH root_name_bound(max_length) AS MATERIALIZED (
  SELECT COALESCE(MAX(LENGTH(name)), 0)
  FROM tags
  WHERE parent_id IS NULL
)
UPDATE tags
SET name =
  'Без темы [user topic #' ||
  id ||
  ';' ||
  HEX(ZEROBLOB((SELECT max_length + 1 FROM root_name_bound))) ||
  ']'
WHERE name = 'Без темы' AND parent_id IS NULL;

INSERT INTO tags (name, parent_id, color, system_kind)
VALUES ('Без темы', NULL, '#64748b', 'untagged');

CREATE UNIQUE INDEX tags_system_kind_unique
ON tags (system_kind)
WHERE system_kind IS NOT NULL;

CREATE TRIGGER system_topic_update
BEFORE UPDATE ON tags
WHEN OLD.system_kind IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'system tag is immutable');
END;

CREATE TRIGGER system_topic_delete
BEFORE DELETE ON tags
WHEN OLD.system_kind IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'system tag is immutable');
END;

INSERT INTO tab_tags (tab_id, tag_id, assigned_by)
SELECT tabs.id, default_topic.id, 'agent'
FROM tabs
CROSS JOIN tags AS default_topic
WHERE default_topic.system_kind = 'untagged'
  AND NOT EXISTS (
    SELECT 1
    FROM tab_tags
    WHERE tab_tags.tab_id = tabs.id
  );

CREATE TRIGGER default_topic_tabs_insert
AFTER INSERT ON tabs
BEGIN
  INSERT INTO tab_tags (tab_id, tag_id, assigned_by)
  SELECT NEW.id, tags.id, 'agent'
  FROM tags
  WHERE tags.system_kind = 'untagged';
END;

CREATE TRIGGER default_topic_real_assignment_insert
AFTER INSERT ON tab_tags
WHEN (
  SELECT tags.system_kind
  FROM tags
  WHERE tags.id = NEW.tag_id
) IS NULL
BEGIN
  DELETE FROM tab_tags
  WHERE tab_id = NEW.tab_id
    AND tag_id IN (
      SELECT id
      FROM tags
      WHERE system_kind = 'untagged'
    );
END;

CREATE TRIGGER default_topic_system_assignment_insert
AFTER INSERT ON tab_tags
WHEN (
  SELECT tags.system_kind
  FROM tags
  WHERE tags.id = NEW.tag_id
) = 'untagged'
AND EXISTS (
  SELECT 1
  FROM tab_tags
  JOIN tags ON tags.id = tab_tags.tag_id
  WHERE tab_tags.tab_id = NEW.tab_id
    AND tags.system_kind IS NULL
)
BEGIN
  DELETE FROM tab_tags
  WHERE tab_id = NEW.tab_id AND tag_id = NEW.tag_id;
END;

CREATE TRIGGER default_topic_last_assignment_delete
AFTER DELETE ON tab_tags
WHEN EXISTS (
  SELECT 1
  FROM tabs
  WHERE tabs.id = OLD.tab_id
)
AND NOT EXISTS (
  SELECT 1
  FROM tab_tags
  WHERE tab_tags.tab_id = OLD.tab_id
)
BEGIN
  INSERT INTO tab_tags (tab_id, tag_id, assigned_by)
  SELECT OLD.tab_id, tags.id, 'agent'
  FROM tags
  WHERE tags.system_kind = 'untagged';
END;
