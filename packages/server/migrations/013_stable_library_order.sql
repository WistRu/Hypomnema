CREATE INDEX tabs_stable_browser_id_idx
ON tabs (
  CASE browser
    WHEN 'chrome' THEN 0
    WHEN 'yandex' THEN 1
    WHEN 'edge' THEN 2
    WHEN 'other' THEN 3
    ELSE 4
  END,
  browser COLLATE NOCASE,
  browser,
  id
);
