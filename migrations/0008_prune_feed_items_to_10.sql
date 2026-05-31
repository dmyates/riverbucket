DELETE FROM feed_items
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY feed_id
        ORDER BY COALESCE(published_at, discovered_at) DESC
      ) AS row_number
    FROM feed_items
  )
  WHERE row_number > 10
);
