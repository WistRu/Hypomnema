CREATE TRIGGER system_topic_child_insert
BEFORE INSERT ON tags
WHEN NEW.parent_id IN (
  SELECT id
  FROM tags
  WHERE system_kind IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'system tag cannot contain children');
END;

CREATE TRIGGER system_topic_parent_update
BEFORE UPDATE OF parent_id ON tags
WHEN NEW.parent_id IN (
  SELECT id
  FROM tags
  WHERE system_kind IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'system tag cannot contain children');
END;

CREATE TRIGGER default_topic_assignment_key_update
BEFORE UPDATE OF tab_id, tag_id ON tab_tags
BEGIN
  SELECT RAISE(ABORT, 'tab topic assignment keys are immutable');
END;
