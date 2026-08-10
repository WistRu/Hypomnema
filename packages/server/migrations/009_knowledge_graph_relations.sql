CREATE TABLE knowledge_entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tab', 'topic')),
  tab_id INTEGER UNIQUE REFERENCES tabs(id) ON DELETE CASCADE,
  topic_id INTEGER UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
  CHECK (
    (kind = 'tab' AND tab_id IS NOT NULL AND topic_id IS NULL) OR
    (kind = 'topic' AND topic_id IS NOT NULL AND tab_id IS NULL)
  )
);

INSERT INTO knowledge_entities (kind, tab_id)
SELECT 'tab', id
FROM tabs
ORDER BY id;

INSERT INTO knowledge_entities (kind, topic_id)
SELECT 'topic', id
FROM tags
ORDER BY id;

CREATE TABLE relations (
  id INTEGER PRIMARY KEY,
  from_entity_id INTEGER NOT NULL
    REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  to_entity_id INTEGER NOT NULL
    REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'related',
  note TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  CHECK (from_entity_id != to_entity_id)
);

INSERT INTO relations (
  id,
  from_entity_id,
  to_entity_id,
  kind,
  note,
  created_by
)
SELECT
  links.id,
  from_entity.id,
  to_entity.id,
  links.kind,
  links.note,
  links.created_by
FROM links
JOIN knowledge_entities AS from_entity
  ON from_entity.kind = 'tab' AND from_entity.tab_id = links.from_tab
JOIN knowledge_entities AS to_entity
  ON to_entity.kind = 'tab' AND to_entity.tab_id = links.to_tab
ORDER BY links.id;

CREATE INDEX knowledge_entities_kind_idx
ON knowledge_entities (kind, id);

CREATE INDEX relations_from_entity_idx
ON relations (from_entity_id, kind, to_entity_id);

CREATE INDEX relations_to_entity_idx
ON relations (to_entity_id, kind, from_entity_id);

CREATE INDEX tags_parent_idx
ON tags (parent_id, id);

CREATE TRIGGER knowledge_entities_tabs_insert
AFTER INSERT ON tabs
BEGIN
  INSERT INTO knowledge_entities (kind, tab_id)
  VALUES ('tab', NEW.id);
END;

CREATE TRIGGER knowledge_entities_topics_insert
AFTER INSERT ON tags
BEGIN
  INSERT INTO knowledge_entities (kind, topic_id)
  VALUES ('topic', NEW.id);
END;

DROP TABLE links;
