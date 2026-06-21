CREATE TABLE IF NOT EXISTS feed_refresh_batches (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  total_jobs INTEGER NOT NULL,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_refresh_batch_jobs (
  batch_id TEXT NOT NULL REFERENCES feed_refresh_batches(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL,
  completed_at TEXT,
  completion_token TEXT,
  PRIMARY KEY (batch_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_refresh_batches_cleanup
ON feed_refresh_batches(notified_at, created_at);
