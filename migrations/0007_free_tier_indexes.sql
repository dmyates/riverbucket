CREATE INDEX IF NOT EXISTS idx_feeds_active_last_fetch
ON feeds(is_active, last_fetched_at, created_at);

CREATE INDEX IF NOT EXISTS idx_feed_items_feed_recent
ON feed_items(feed_id, published_at DESC, discovered_at DESC);
