CREATE INDEX IF NOT EXISTS idx_bookmarks_source_feed_item
ON bookmarks(source_feed_item_id)
WHERE source_feed_item_id IS NOT NULL;
