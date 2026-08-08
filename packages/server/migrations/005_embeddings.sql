CREATE TABLE embedding_metadata (
  tab_id INTEGER PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = 512),
  source_content_revision INTEGER NOT NULL CHECK (source_content_revision > 0),
  embedded_at TEXT NOT NULL
);

CREATE INDEX embedding_metadata_source_idx
ON embedding_metadata (provider, model, dimensions, source_content_revision);

CREATE VIRTUAL TABLE vec_contents USING vec0(
  tab_id INTEGER PRIMARY KEY,
  embedding FLOAT[512] distance_metric=cosine
);

CREATE TRIGGER contents_embedding_after_revision_update
AFTER UPDATE OF content_revision ON contents
WHEN OLD.content_revision IS NOT NEW.content_revision
BEGIN
  DELETE FROM vec_contents WHERE tab_id = OLD.tab_id;
  DELETE FROM embedding_metadata WHERE tab_id = OLD.tab_id;
END;

CREATE TRIGGER contents_embedding_after_delete
AFTER DELETE ON contents
BEGIN
  DELETE FROM vec_contents WHERE tab_id = OLD.tab_id;
  DELETE FROM embedding_metadata WHERE tab_id = OLD.tab_id;
END;

CREATE TRIGGER tabs_embedding_after_delete
AFTER DELETE ON tabs
BEGIN
  DELETE FROM vec_contents WHERE tab_id = OLD.id;
END;
