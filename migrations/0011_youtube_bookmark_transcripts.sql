CREATE TABLE IF NOT EXISTS bookmark_transcripts (
  bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  video_id TEXT NOT NULL,
  language_code TEXT,
  language_name TEXT,
  track_kind TEXT,
  status TEXT NOT NULL,
  text TEXT,
  unavailable_reason TEXT,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmark_transcripts_video
ON bookmark_transcripts(provider, video_id);
