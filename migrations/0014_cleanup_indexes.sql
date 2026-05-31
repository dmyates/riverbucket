CREATE INDEX IF NOT EXISTS idx_extension_tokens_token_hash
ON extension_tokens(token_hash)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookmarks_canonical_url
ON bookmarks(canonical_url)
WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookmarks_domain_saved
ON bookmarks(domain, saved_at DESC)
WHERE status != 'deleted';

CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag
ON bookmark_tags(tag_id, bookmark_id);
