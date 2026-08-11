-- Activity can arrive before the debounced browser snapshot. Materialize every
-- exact page aggregate as a closed canonical Library record so short visits do
-- not remain invisible forever. A later snapshot reuses the same unique key
-- and opens/enriches the record in place.
INSERT INTO tabs (
  url,
  url_normalized,
  title,
  browser,
  window_id,
  tab_index,
  favicon_url,
  is_open,
  first_seen_at,
  last_seen_at,
  closed_at
)
SELECT
  page_activity.url,
  page_activity.url_normalized,
  NULL,
  page_activity.browser,
  NULL,
  NULL,
  NULL,
  0,
  page_activity.first_activity_at,
  page_activity.last_activity_at,
  page_activity.last_activity_at
FROM tab_page_activity_totals AS page_activity
WHERE NOT EXISTS (
  SELECT 1
  FROM tabs
  WHERE tabs.browser = page_activity.browser
    AND tabs.url_normalized = page_activity.url_normalized
)
ORDER BY page_activity.browser, page_activity.url_normalized;
