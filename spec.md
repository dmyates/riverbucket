Below is a fleshed-out v1 spec that follows the design philosophy in your posts: follow the open web, avoid inbox guilt, avoid reader-mode homogenisation, show links rather than rendering content, and keep the app small enough that it remains yours.

# Working name

**Riverbucket**

The app has two conceptual objects:

**River**: a low-pressure stream of recent links from things you follow.

**Bucket**: a manual read-later list of links you intentionally saved.

The name can change, but this split is useful because it prevents the app from becoming another inbox.

# Product principles

The app should be a link-following tool, not a reading environment. Your reader-mode post argues for reading on original websites because site design helps memory and preserves formatting/context that reader modes can lose. That maps directly to “no internal reader interface” as a core product rule. ([davidyat.es][1])

The RSS screen should avoid unread counts, read/unread state, gamification, notifications, and algorithmic ranking. In your Fraidycat post, the central appeal is that it does not behave like an email client: no unread tally, no embedded reading interface, and no pressure to process everything. ([davidyat.es][2])

The river view should preserve “source-first” browsing rather than becoming a single recency firehose. Your Substack UX post praises the nested list model: each subscription shown with its recent posts, all visible in a compact digest, rather than Substack’s inbox/chat/social-feed metaphors. ([davidyat.es][3])

The app should do almost nothing automatically beyond fetching feeds. Saving to the bucket is manual. Archiving, marking read, recommendations, and “you have 324 unread posts” are out.

# Target platform

Use **Cloudflare Workers** as the app host/API layer, with a static frontend served by the same Worker or Cloudflare’s frontend tooling. Use **D1** for relational storage, because the app has structured data and needs joins between feeds, feed items, saved bookmarks, tags, and extension tokens. Cloudflare Cron Triggers can run a Worker `scheduled()` handler to refresh feeds periodically. ([Cloudflare Docs][4])

Use one hibernating Durable Object per deployment to coordinate live invalidation events across tabs and devices. D1 remains the source of truth; clients refetch only the affected active view after receiving an event. ([Cloudflare Docs][5])

Suggested stack:

```text
Cloudflare Worker
  serves app shell
  exposes small JSON API
  runs scheduled feed refresh

Cloudflare D1
  feeds
  feed_items
  bookmarks
  tags
  extension auth tokens
  fetch logs

Browser extension
  detects feeds
  saves current page
  saves right-clicked links
  opens app screens
```

# Screens

## 1. River

The river is the RSS subscription view. It should be organised by source, not by unread state.

Default layout:

```text
[All] [Frequent] [Sometimes] [Rare] [Tag...]

Site Name
  Latest post title        2h ago
  Another post             yesterday
  Third post               2026-05-12
  [show 10]

Another Site
  Post / Post / Post / Post / Post
```

Each feed card should show:

```text
Feed title
Site URL
Last fetched / fetch status only when useful
5 recent items by default
Expandable to 10 or 20
Subscribe/edit/remove controls
```

Each item row should show:

```text
Title
Source favicon or small domain text
Published date
External-link button
Save to bucket button
Optional “copy link” button
```

Important omissions:

```text
No unread count
No read/unread badges
No internal article rendering
No “mark all as read”
No infinite guilt-scroll
No notifications
```

Visited links can rely on browser styling. That preserves the Fraidycat-style “your browser already knows what you clicked” behaviour.

## 2. Bucket

The bucket is the manual read-later/bookmark screen.

Default layout:

```text
[Inbox] [Reading] [Done] [Archive]       Search...
[all tags] [writing] [security] [games]

Saved page title
example.com
Saved 2026-05-17
[open] [archive] [tag] [delete]
```

A bookmark should be just enough metadata to re-find and open the page:

```text
URL
Canonical URL if discoverable
Title
Description, optional
Site name/domain
Saved timestamp
Source: manual / extension / RSS item
Tags
Status: bucket | archived | deleted
Notes, optional but hidden by default
```

I would keep “done” and “archive” separate only if useful. Otherwise v1 can have one action: **Archive**. The bucket is then a current list, and archived bookmarks remain searchable.

# Core flows

## Subscribe to a feed

From the app:

1. User enters a site URL or feed URL.
2. Worker fetches it.
3. If HTML, parse feed discovery links from `<link rel="alternate">`.
4. If multiple feeds are found, user chooses one.
5. Fetch and parse feed.
6. Store feed and recent items.
7. Show it in River.

From extension:

1. Extension detects feeds on current page.
2. Toolbar icon indicates feed availability.
3. User clicks “Subscribe”.
4. Extension sends feed URL and page URL to app API.
5. App confirms subscription or opens a choose-feed page if there are multiple candidates.

## Save current page to bucket

From extension toolbar:

1. User clicks extension.
2. Chooses “Save page”.
3. Extension sends URL, title, selected text if any, and page metadata.
4. Bookmark appears in Bucket.

## Right-click link save

This is crucial and should be in v1.

Context menu items:

```text
Save link to Riverbucket
Save page to Riverbucket
```

For a right-clicked link, the extension sends:

```json
{
  "url": "https://example.com/article",
  "source_page_url": "https://site-containing-link.example/",
  "source_page_title": "Page where I found this",
  "link_text": "The text of the clicked link"
}
```

The bookmark title can initially be the link text, then the app can opportunistically fetch the target page title later.

## Save RSS item to bucket

In River, every item gets a small **Save** action. This creates a bookmark with:

```text
bookmark.url = feed_item.url
bookmark.title = feed_item.title
bookmark.source = rss_item
bookmark.source_feed_id = feed.id
bookmark.source_feed_item_id = feed_item.id
```

If already saved, the button becomes “Saved” and should not create duplicates.

# Data model

A practical D1 schema:

```sql
CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL UNIQUE,
  site_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  favicon_url TEXT,
  category TEXT,
  importance TEXT DEFAULT 'standard',
  is_active INTEGER NOT NULL DEFAULT 1,
  fetch_interval_minutes INTEGER DEFAULT 60,
  last_fetched_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feed_items (
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

CREATE INDEX idx_feed_items_feed_published
ON feed_items(feed_id, published_at DESC);

CREATE TABLE bookmarks (
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

CREATE INDEX idx_bookmarks_status_saved
ON bookmarks(status, saved_at DESC);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE TABLE extension_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
```

For a single-user app, avoid user tables in v1. Use a single app password/session for the web UI and scoped extension token for the extension.

# Feed refresh behaviour

Use a scheduled Worker to refresh feeds. Cloudflare Cron Triggers are designed for scheduled jobs such as periodic API calls or maintenance tasks, and can be configured through Wrangler. ([Cloudflare Docs][4])

v1 strategy:

```text
Cron runs every 30 or 60 minutes.
Worker selects feeds due for refresh.
Fetches a limited batch per run.
Parses RSS/Atom/JSON Feed.
Upserts new items.
Keeps only the latest N items per feed, e.g. 50 or 100.
Stores fetch errors without surfacing them loudly.
```

Do not fetch every feed on every cron run if the list grows. Use `last_fetched_at` and `fetch_interval_minutes`.

Possible importance mapping:

```text
Realtime/Frequent: every 30–60 minutes
Sometimes: every 6 hours
Rare: every 24 hours
Dormant: manual only
```

This borrows the useful part of Fraidycat’s importance model without turning it into an urgency system.

# API surface

Keep the API boring.

```text
GET  /api/feeds
POST /api/feeds/discover
POST /api/feeds
PATCH /api/feeds/:id
DELETE /api/feeds/:id

GET  /api/river?category=
POST /api/feed-items/:id/save

GET  /api/bookmarks?status=bucket&tag=&q=
POST /api/bookmarks
PATCH /api/bookmarks/:id
POST /api/bookmarks/:id/archive
DELETE /api/bookmarks/:id

GET  /api/tags
POST /api/tags

POST /api/extension/save-link
POST /api/extension/subscribe
POST /api/extension/discover-feeds
```

`POST /api/bookmarks` should be idempotent by URL. If the URL already exists, update metadata only if missing, then return the existing bookmark.

# Extension spec

Manifest V3 WebExtension.

Permissions:

```json
{
  "permissions": ["contextMenus", "activeTab", "storage"],
  "host_permissions": ["<all_urls>"]
}
```

Core extension features:

```text
Toolbar popup:
  Save current page
  Subscribe to detected feed
  Open River
  Open Bucket

Content/feed detection:
  Detect <link rel="alternate" type="application/rss+xml">
  Detect Atom and JSON Feed links
  Fall back to sending current page URL to app for server-side discovery

Context menus:
  Save this link to read later
  Save current page to read later
```

Extension settings:

```text
App URL
Extension token
Default save behaviour
Optional default tag
```

Authentication should be simple: the app generates a token, extension stores it, API receives it as `Authorization: Bearer ...`. Store only a hash of the token in D1.

# UI detail

## River item actions

For each item:

```text
Title links directly to original URL.
Domain/source is visible.
Published date is visible.
Save button is small and secondary.
No preview text by default.
```

Optional item menu:

```text
Copy link
Save to bucket
Open archive.org snapshot
Hide this item locally
```

I would postpone hide/mute until later. It starts pulling the app toward read-state tracking.

## Bucket item actions

For each bookmark:

```text
Open
Archive
Tag
Delete
Copy link
```

Avoid “reading progress”, “estimated read time”, and generated summaries in v1. Those features pull the product toward the reader-app category you are explicitly avoiding.

# Archive.org support

Make this a graceful v1.1 feature.

Minimum viable version:

```text
Every external link gets a secondary “Archive” link:
https://web.archive.org/web/*/{url}
```

Better version:

```text
When saving a bookmark, optionally call archive.org Save Page Now.
Store archive_url if available.
If opening the original link fails from the app’s metadata refresh, show archive option more prominently.
```

But I would avoid automatic archiving in v1 unless you specifically want it. It adds external API behaviour, rate limits, and failure cases.

# Import/export

This matters for trust.

v1 should support:

```text
Import OPML
Export OPML
Export bookmarks as JSON
Export bookmarks as Netscape bookmarks HTML
Export all data as SQLite dump or JSON bundle
```

OPML import/export is especially important because RSS tools should not trap subscriptions.

# Non-goals for v1

```text
No article reader
No full-text extraction
No unread counts
No recommendation engine
No notifications
No social features
No comments
No AI summaries
No mobile app
No multi-user accounts
No paid/free split
No newsletter inbox
No email ingestion
```

# Suggested v1 milestones

## Milestone 1: Local prototype

Build the data model, feed parser, and two screens against local D1/SQLite.

Must work:

```text
Add feed URL
Fetch items
Display River grouped by feed
Save feed item to Bucket
Add arbitrary bookmark manually
Open external links
Archive bookmarks
```

## Milestone 2: Cloudflare deployment

Add Worker routes, D1 binding, cron refresh, and basic auth.

Must work:

```text
Deploy app
Scheduled feed refresh
Manual refresh feed
OPML import/export
```

## Milestone 3: Extension

Build the browser extension.

Must work:

```text
Save current page
Right-click link save
Detect feed on page
Subscribe from toolbar
Configure app URL and token
```

## Milestone 4: Polish

Add search, tags, favicon handling, better duplicate detection, and dead-link/archive affordances.

# Opinionated v1 cut

For the first usable version, I would build exactly this:

```text
River:
  grouped by feed
  5 recent links per feed
  expand to 20
  save item to bucket

Bucket:
  saved links
  tags
  archive/delete
  search by title/domain/url

Feeds:
  add URL
  auto-discover feed
  OPML import/export
  standard refresh cadence

Extension:
  save current page
  right-click save link
  subscribe to current site feed

Infrastructure:
  Cloudflare Worker
  D1
  Cron Trigger
  one Durable Object for app-wide live synchronization
  no Queues unless refreshes become unreliable
```

The key design constraint is that **River is not a queue**. It is a window. You look through it, click what catches your eye, and save only what you intentionally want to return to.

[1]: https://davidyat.es/2020/03/14/reader-modes/ "Browser reader modes"
[2]: https://davidyat.es/2020/09/05/fraidycat/ "Fraidycat"
[3]: https://davidyat.es/2024/03/29/substack-ux/ "The many (bad) interfaces of Substack"
[4]: https://developers.cloudflare.com/workers/configuration/cron-triggers/?utm_source=chatgpt.com "Cron Triggers - Workers"
[5]: https://developers.cloudflare.com/durable-objects/?utm_source=chatgpt.com "Overview · Cloudflare Durable Objects docs"
