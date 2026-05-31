ALTER TABLE bookmarks ADD COLUMN dedupe_url TEXT;

UPDATE bookmarks
SET dedupe_url = (
  WITH ranked AS (
    SELECT
      id,
      COALESCE(canonical_url, url) AS value,
      ROW_NUMBER() OVER (PARTITION BY COALESCE(canonical_url, url) ORDER BY saved_at, id) AS rank
    FROM bookmarks
  )
  SELECT CASE
    WHEN rank = 1 THEN value
    ELSE value || '#bookmark-' || id
  END
  FROM ranked
  WHERE ranked.id = bookmarks.id
)
WHERE dedupe_url IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_dedupe_url
ON bookmarks(dedupe_url);
