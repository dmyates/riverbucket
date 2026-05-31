DELETE FROM bookmark_tags
WHERE bookmark_id IN (
  SELECT id FROM bookmarks WHERE status = 'deleted'
);

DELETE FROM bookmarks
WHERE status = 'deleted';
