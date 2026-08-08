CREATE VIRTUAL TABLE contents_fts USING fts5(
  text,
  summary,
  title,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER contents_fts_after_tab_insert
AFTER INSERT ON tabs
BEGIN
  INSERT INTO contents_fts (rowid, text, summary, title)
  VALUES (NEW.id, '', '', COALESCE(NEW.title, ''));
END;

CREATE TRIGGER contents_fts_after_tab_delete
AFTER DELETE ON tabs
BEGIN
  DELETE FROM contents_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER contents_fts_after_title_update
AFTER UPDATE OF title ON tabs
WHEN OLD.title IS NOT NEW.title
BEGIN
  DELETE FROM contents_fts WHERE rowid = NEW.id;
  INSERT INTO contents_fts (rowid, text, summary, title)
  SELECT
    NEW.id,
    COALESCE(contents.text, ''),
    COALESCE(contents.summary, ''),
    COALESCE(NEW.title, '')
  FROM tabs
  LEFT JOIN contents ON contents.tab_id = tabs.id
  WHERE tabs.id = NEW.id;
END;

CREATE TRIGGER contents_fts_after_insert
AFTER INSERT ON contents
BEGIN
  DELETE FROM contents_fts WHERE rowid = NEW.tab_id;
  INSERT INTO contents_fts (rowid, text, summary, title)
  VALUES (
    NEW.tab_id,
    COALESCE(NEW.text, ''),
    COALESCE(NEW.summary, ''),
    COALESCE((SELECT title FROM tabs WHERE id = NEW.tab_id), '')
  );
END;

CREATE TRIGGER contents_fts_after_update
AFTER UPDATE ON contents
BEGIN
  DELETE FROM contents_fts WHERE rowid = OLD.tab_id;
  INSERT INTO contents_fts (rowid, text, summary, title)
  VALUES (
    NEW.tab_id,
    COALESCE(NEW.text, ''),
    COALESCE(NEW.summary, ''),
    COALESCE((SELECT title FROM tabs WHERE id = NEW.tab_id), '')
  );
END;

CREATE TRIGGER contents_fts_after_delete
AFTER DELETE ON contents
BEGIN
  DELETE FROM contents_fts WHERE rowid = OLD.tab_id;
  INSERT INTO contents_fts (rowid, text, summary, title)
  SELECT tabs.id, '', '', COALESCE(tabs.title, '')
  FROM tabs
  WHERE tabs.id = OLD.tab_id;
END;

INSERT INTO contents_fts (rowid, text, summary, title)
SELECT
  tabs.id,
  COALESCE(contents.text, ''),
  COALESCE(contents.summary, ''),
  COALESCE(tabs.title, '')
FROM tabs
LEFT JOIN contents ON contents.tab_id = tabs.id;
