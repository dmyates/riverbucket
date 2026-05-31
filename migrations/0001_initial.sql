PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL UNIQUE,
  site_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  favicon_url TEXT,
  category TEXT,
  importance TEXT DEFAULT 'frequent',
  is_active INTEGER NOT NULL DEFAULT 1,
  fetch_interval_minutes INTEGER DEFAULT 180,
  last_fetched_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  summary TEXT,
  raw_hash TEXT,
  UNIQUE(feed_id, guid),
  UNIQUE(feed_id, url)
);

CREATE INDEX IF NOT EXISTS idx_feed_items_feed_published
ON feed_items(feed_id, published_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  description TEXT,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'bucket',
  source TEXT NOT NULL DEFAULT 'manual',
  source_feed_id TEXT,
  source_feed_item_id TEXT,
  source_page_url TEXT,
  source_page_title TEXT,
  link_text TEXT,
  notes TEXT,
  saved_at TEXT NOT NULL,
  archived_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(url)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_status_saved
ON bookmarks(status, saved_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE TABLE IF NOT EXISTS extension_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
