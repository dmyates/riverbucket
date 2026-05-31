CREATE TABLE IF NOT EXISTS feed_tags (
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_tags_tag
ON feed_tags(tag_id, feed_id);
