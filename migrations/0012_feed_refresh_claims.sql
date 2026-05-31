ALTER TABLE feeds ADD COLUMN refresh_claimed_at TEXT;
ALTER TABLE feeds ADD COLUMN refresh_claim_id TEXT;

CREATE INDEX IF NOT EXISTS idx_feeds_refresh_claim
ON feeds(is_active, refresh_claimed_at);
