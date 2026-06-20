import { XMLParser } from "fast-xml-parser";
import { HttpError, json, largeImportJsonBodyMaxBytes, readJson } from "./http";
import { normalizePublicHttpUrl, safeParsedUrl } from "./url-safety";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  FEED_REFRESH_QUEUE?: Queue<FeedRefreshMessage>;
  APP_SYNC: DurableObjectNamespace;
  APP_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
};

type AppSyncScope = "river" | "bucket" | "feeds" | "feedTags" | "tags" | "extensionTokens";

type AppInvalidationEvent = {
  type: "app.invalidate";
  scopes: AppSyncScope[];
};

type FeedRefreshMessage = {
  feedId: string;
  claimId?: string;
};

type Feed = {
  id: string;
  feed_url: string;
  site_url: string | null;
  title: string;
  description: string | null;
  favicon_url: string | null;
  category: string | null;
  importance: string;
  auto_save_to_bucket: number;
  is_active: number;
  fetch_interval_minutes: number;
  last_fetched_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  refresh_claimed_at: string | null;
  refresh_claim_id: string | null;
  created_at: string;
  updated_at: string;
  tags?: string[];
};

type FeedItem = {
  id: string;
  feed_id: string;
  guid: string | null;
  url: string;
  canonical_url: string | null;
  title: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  summary: string | null;
  raw_hash: string | null;
  saved_id?: string | null;
};

type Bookmark = {
  id: string;
  url: string;
  canonical_url: string | null;
  dedupe_url: string | null;
  title: string | null;
  description: string | null;
  domain: string | null;
  status: string;
  source: string;
  source_feed_id: string | null;
  source_feed_item_id: string | null;
  source_page_url: string | null;
  source_page_title: string | null;
  link_text: string | null;
  notes: string | null;
  saved_at: string;
  archived_at: string | null;
  updated_at: string;
  tags?: string[];
};

type ParsedFeed = {
  title: string;
  description?: string;
  siteUrl?: string;
  items: Array<{
    guid?: string;
    url: string;
    title: string;
    author?: string;
    publishedAt?: string;
    summary?: string;
  }>;
};

type FeedCandidate = {
  title: string;
  feedUrl: string;
  siteUrl: string;
  type?: string;
  confidence?: "primary" | "alternate";
  source?: "html" | "known-site" | "common-path";
};

type ImportFeedInput = {
  feedUrl?: string;
  title?: string;
};

type ImportFeedBatchResult = {
  imported: number;
  skipped: number;
  ignored: number;
  feedIds: string[];
};

type ImportBookmarkInput = Partial<Bookmark> & {
  url?: string;
  tags?: string[];
};

type ImportBookmarkBatchResult = {
  imported: number;
  skipped: number;
  ignored: number;
  bookmarkIds: string[];
};

type ImportTableSummary = {
  imported: number;
  skipped: number;
  ignored: number;
};

type ImportAllJsonResult = {
  feeds: ImportTableSummary;
  feed_items: ImportTableSummary;
  bookmarks: ImportTableSummary;
  tags: ImportTableSummary;
  bookmark_tags: ImportTableSummary;
  feed_tags: ImportTableSummary;
};

const standardFeedImportance = "standard";
const standardFeedRefreshMinutes = 60;
const maxRiverItemsPerFeed = 10;
const maxFeedRefreshItems = 10;
const maxCronRefreshEnqueues = 20;
const maxStartupRefreshEnqueues = 5;
const maxRefreshBatchSize = 5;
const maxBookmarkPageSize = 100;
const refreshClaimTtlMinutes = 15;
const dueFeedRefreshWhere = `is_active = 1
       AND (last_fetched_at IS NULL OR datetime(last_fetched_at, '+' || fetch_interval_minutes || ' minutes') <= datetime('now'))`;
const claimableDueFeedRefreshWhere = `${dueFeedRefreshWhere}
       AND (refresh_claimed_at IS NULL OR datetime(refresh_claimed_at, '+${refreshClaimTtlMinutes} minutes') <= datetime('now'))`;
const dueFeedClaimOrderBy = `last_fetched_at IS NULL DESC,
     CASE
       WHEN last_fetched_at IS NOT NULL
        AND datetime(last_fetched_at, '+' || (fetch_interval_minutes * 2) || ' minutes') <= datetime('now')
       THEN 0
       ELSE 1
     END,
     CASE
       WHEN last_fetched_at IS NOT NULL
        AND datetime(last_fetched_at, '+' || (fetch_interval_minutes * 2) || ' minutes') <= datetime('now')
       THEN datetime(last_fetched_at, '+' || fetch_interval_minutes || ' minutes')
       ELSE NULL
     END ASC,
     latest.latest_item_time IS NULL ASC,
     latest.latest_item_time DESC,
     COALESCE(last_fetched_at, created_at) ASC`;

export function getDueFeedClaimOrderBy(): string {
  return dueFeedClaimOrderBy;
}

type RefreshBatchResult = {
  refreshed: number;
  inserted: number;
  failed: number;
  results: Array<{ feedId: string; ok: boolean; inserted?: number; error?: string }>;
};

type RefreshQueueResult = {
  queued: number;
  skipped: number;
  total: number;
};

type RiverResponse = {
  groups: Array<{ feed: Feed; items: FeedItem[] }>;
  tags: Array<{ id: string; name: string; feed_count: number }>;
};

type BookmarkSaveResult = {
  bookmark: Bookmark;
  created: boolean;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  processEntities: true
});

const sessionCookie = "rb_session";
const passwordHashAlgorithm = "pbkdf2-sha256";
const passwordHashIterations = 100_000;
const passwordHashBytes = 32;
const devSessionSecret = "dev-session-secret";
const outboundFetchTimeoutMs = 8_000;
const outboundPageMaxBytes = 1_000_000;
const outboundFeedMaxBytes = 5_000_000;
const outboundFetchMaxRedirects = 3;
const commonFeedPaths = ["/feed/", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx).catch((error) => {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        console.error(error);
        return json({ error: "Internal server error" }, 500);
      });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshDueFeeds(env));
  },

  async queue(batch: MessageBatch<FeedRefreshMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processFeedRefreshMessage(env, message.body);
      message.ack();
    }
  }
};

export class AppSync {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426);
      }
      const clientId = request.headers.get("x-riverbucket-client-id") || "";
      if (!validClientId(clientId)) return json({ error: "Invalid client ID" }, 400);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ clientId });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      const event = await readJson<AppInvalidationEvent & { sourceClientId?: string }>(request);
      if (event.type !== "app.invalidate" || !Array.isArray(event.scopes)) {
        return json({ error: "Invalid event" }, 400);
      }
      const scopes = normalizeAppSyncScopes(event.scopes);
      if (scopes.length === 0) return json({ ok: true, delivered: 0 });

      const payload = JSON.stringify({ type: "app.invalidate", scopes } satisfies AppInvalidationEvent);
      let delivered = 0;
      for (const socket of this.state.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as { clientId?: string } | null;
        if (event.sourceClientId && attachment?.clientId === event.sourceClientId) continue;
        try {
          socket.send(payload);
          delivered += 1;
        } catch {
          try {
            socket.close(1011, "Delivery failed");
          } catch {
            // The socket is already closed.
          }
        }
      }
      return json({ ok: true, delivered });
    }

    return json({ error: "Not found" }, 404);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === "POST" && path === "/api/login") {
    const csrf = requireSameOriginForMutation(request);
    if (csrf instanceof Response) return csrf;
    return login(request, env);
  }

  if (path.startsWith("/api/extension/")) {
    const token = await requireExtensionToken(request, env);
    if (token instanceof Response) return token;
  } else {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const csrf = requireSameOriginForMutation(request);
    if (csrf instanceof Response) return csrf;
  }

  if (method === "GET" && path === "/api/me") return json({ authenticated: true });
  if (method === "GET" && path === "/api/startup/river") return startupRiver(request, env, ctx);
  if (method === "GET" && path === "/api/app/live") return openAppSyncSocket(request, env);
  if (method === "POST" && path === "/api/logout") return logout(request);

  if (method === "GET" && path === "/api/feeds") return listFeeds(env);
  if (method === "GET" && path === "/api/feed-tags") return listFeedTags(env);
  if (method === "POST" && path === "/api/feeds/discover") return discoverFeedsEndpoint(request);
  if (method === "POST" && path === "/api/feeds") return createFeed(request, env);
  if (method === "POST" && path === "/api/feeds/refresh-batch") return refreshFeedBatchEndpoint(request, env, ctx);
  if (method === "POST" && path === "/api/feeds/bulk-delete") return bulkDeleteFeeds(request, env);
  if (method === "POST" && path === "/api/feeds/bulk-tags") return bulkTagFeeds(request, env);

  const feedRefresh = path.match(/^\/api\/feeds\/([^/]+)\/refresh$/);
  if (feedRefresh && method === "POST") return refreshFeedEndpoint(request, env, feedRefresh[1]);

  const feedMatch = path.match(/^\/api\/feeds\/([^/]+)$/);
  if (feedMatch && method === "PATCH") return updateFeed(request, env, feedMatch[1]);
  if (feedMatch && method === "DELETE") return deleteFeed(request, env, feedMatch[1]);

  if (method === "GET" && path === "/api/river") return getRiver(request, env);

  const saveItemMatch = path.match(/^\/api\/feed-items\/([^/]+)\/save$/);
  if (saveItemMatch && method === "POST") return saveFeedItem(request, env, saveItemMatch[1]);

  if (method === "GET" && path === "/api/bookmarks") return listBookmarks(request, env);
  if (method === "POST" && path === "/api/bookmarks") return upsertBookmarkEndpoint(request, env, "manual");

  const bookmarkArchive = path.match(/^\/api\/bookmarks\/([^/]+)\/archive$/);
  if (bookmarkArchive && method === "POST") return archiveBookmark(request, env, bookmarkArchive[1]);

  const bookmarkRestore = path.match(/^\/api\/bookmarks\/([^/]+)\/restore$/);
  if (bookmarkRestore && method === "POST") return restoreBookmark(request, env, bookmarkRestore[1]);

  const bookmarkTag = path.match(/^\/api\/bookmarks\/([^/]+)\/tags$/);
  if (bookmarkTag && method === "POST") return setBookmarkTagsEndpoint(request, env, bookmarkTag[1]);

  const bookmarkMatch = path.match(/^\/api\/bookmarks\/([^/]+)$/);
  if (bookmarkMatch && method === "PATCH") return updateBookmark(request, env, bookmarkMatch[1]);
  if (bookmarkMatch && method === "DELETE") return deleteBookmark(request, env, bookmarkMatch[1]);

  if (method === "GET" && path === "/api/tags") return listTags(env);
  if (method === "POST" && path === "/api/tags") return createTagEndpoint(request, env);

  if (method === "POST" && path === "/api/import/opml-feeds") return importOpmlFeeds(request, env);
  if (method === "POST" && path === "/api/import/opml") return importOpml(request, env);
  if (method === "POST" && path === "/api/import/bookmarks") return importBookmarks(request, env);
  if (method === "POST" && path === "/api/import/all-json") return importAllJson(request, env);
  if (method === "GET" && path === "/api/export/opml") return exportOpml(request, env);
  if (method === "GET" && path === "/api/export/bookmarks.json") return exportBookmarksJson(request, env);
  if (method === "GET" && path === "/api/export/bookmarks.html") return exportBookmarksHtml(request, env);
  if (method === "GET" && path === "/api/export/all.json") return exportAllJson(request, env);

  if (method === "GET" && path === "/api/extension-tokens") return listExtensionTokens(env);
  if (method === "POST" && path === "/api/extension-tokens") return createExtensionToken(request, env);
  const tokenRevoke = path.match(/^\/api\/extension-tokens\/([^/]+)\/revoke$/);
  if (tokenRevoke && method === "POST") return revokeExtensionToken(request, env, tokenRevoke[1]);

  if (method === "POST" && path === "/api/extension/save-link") return saveExtensionLink(request, env);
  if (method === "POST" && path === "/api/extension/subscribe") return extensionSubscribe(request, env);
  if (method === "POST" && path === "/api/extension/discover-feeds") return discoverFeedsEndpoint(request);

  return json({ error: "Not found" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ password?: string }>(request);
  if (!body.password) return json({ error: "Password required" }, 400);
  if (!env.APP_PASSWORD_HASH && !allowDevAuthDefaults(request)) {
    return json({ error: "Authentication is not configured" }, 500);
  }
  if (!(await verifyAppPassword(body.password, env.APP_PASSWORD_HASH, allowDevAuthDefaults(request)))) {
    return json({ error: "Invalid password" }, 401);
  }

  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
  const payload = btoaUrl(JSON.stringify({ exp: expires }));
  const secret = sessionSecret(request, env);
  if (!secret) return json({ error: "Session signing is not configured" }, 500);
  const sig = await hmac(`${payload}`, secret);
  const cookie = sessionCookieHeader(request, `${payload}.${sig}`, 60 * 60 * 24 * 14);
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

function logout(request: Request): Response {
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookieHeader(request, "", 0)
  });
}

async function openAppSyncSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "WebSocket upgrade required" }, 426);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Cross-site request rejected" }, 403);
  }
  const clientId = new URL(request.url).searchParams.get("clientId") || "";
  if (!validClientId(clientId)) return json({ error: "Invalid client ID" }, 400);

  return env.APP_SYNC.getByName("app").fetch("https://app-sync/connect", {
    headers: {
      upgrade: "websocket",
      "x-riverbucket-client-id": clientId
    }
  });
}

async function requireSession(request: Request, env: Env): Promise<true | Response> {
  const cookie = parseCookies(request.headers.get("cookie") || "")[sessionCookie];
  if (!cookie) return json({ error: "Authentication required" }, 401);
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return json({ error: "Authentication required" }, 401);
  const secret = sessionSecret(request, env);
  if (!secret) return json({ error: "Session signing is not configured" }, 500);
  const expected = await hmac(payload, secret);
  if (!timingSafeEqual(sig, expected)) return json({ error: "Authentication required" }, 401);
  try {
    const data = JSON.parse(atobUrl(payload)) as { exp: number };
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return json({ error: "Session expired" }, 401);
  } catch {
    return json({ error: "Authentication required" }, 401);
  }
  return true;
}

async function requireExtensionToken(request: Request, env: Env): Promise<true | Response> {
  const header = request.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Extension token required" }, 401);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT id, last_used_at FROM extension_tokens WHERE token_hash = ? AND revoked_at IS NULL"
  ).bind(tokenHash).first<{ id: string; last_used_at: string | null }>();
  if (!row) return json({ error: "Invalid extension token" }, 401);
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60 * 60 * 1000) {
    await env.DB.prepare("UPDATE extension_tokens SET last_used_at = ? WHERE id = ?").bind(now(), row.id).run();
    await publishAppInvalidation(env, ["extensionTokens"]);
  }
  return true;
}

async function listFeeds(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM feeds ORDER BY title COLLATE NOCASE").all<Feed>();
  const feeds = rows.results || [];
  const tagsByFeed = await getFeedTagsMap(env, feeds.map((feed) => feed.id));
  for (const feed of feeds) feed.tags = tagsByFeed.get(feed.id) || [];
  return json({ feeds });
}

async function listFeedTags(env: Env): Promise<Response> {
  return json({ tags: await listFeedTagRows(env) });
}

async function listFeedTagRows(env: Env): Promise<Array<{ id: string; name: string; feed_count: number }>> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, COUNT(ft.feed_id) AS feed_count
     FROM tags t
     JOIN feed_tags ft ON ft.tag_id = t.id
     JOIN feeds f ON f.id = ft.feed_id
     WHERE f.is_active = 1
     GROUP BY t.id, t.name
     ORDER BY t.name COLLATE NOCASE`
  ).all<{ id: string; name: string; feed_count: number }>();
  return rows.results || [];
}

async function discoverFeedsEndpoint(request: Request): Promise<Response> {
  const body = await readJson<{ url?: string }>(request);
  if (!body.url) return json({ error: "URL required" }, 400);
  const candidates = await discoverFeeds(body.url);
  return json({ feeds: candidates });
}

async function createFeed(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ url?: string; feedUrl?: string; title?: string; category?: string; auto_save_to_bucket?: number | boolean; tags?: string[] }>(request);
  const inputUrl = body.feedUrl || body.url;
  if (!inputUrl) return json({ error: "Feed URL or site URL required" }, 400);

  let feedUrl = normalizePublicHttpUrl(inputUrl);
  let siteUrl: string | undefined;
  let parsed: ParsedFeed;
  try {
    parsed = await fetchAndParseFeed(feedUrl);
  } catch {
    const candidates = await discoverFeeds(feedUrl);
    if (candidates.length === 0) return json({ error: "No feed found" }, 422);
    const primaryCandidates = candidates.filter((candidate) => candidate.confidence === "primary");
    const selectedCandidate = primaryCandidates.length === 1 ? primaryCandidates[0] : candidates[0];
    if (candidates.length > 1 && primaryCandidates.length !== 1 && !body.feedUrl) return json({ needsChoice: true, feeds: candidates }, 409);
    feedUrl = selectedCandidate.feedUrl;
    siteUrl = selectedCandidate.siteUrl;
    parsed = await fetchAndParseFeed(feedUrl);
  }

  const existing = await env.DB.prepare("SELECT * FROM feeds WHERE feed_url = ?").bind(feedUrl).first<Feed>();
  if (existing) {
    existing.tags = await getFeedTags(env, existing.id);
    return json({ feed: existing, existing: true });
  }

  const id = crypto.randomUUID();
  const timestamp = now();
  const feed: Feed = {
    id,
    feed_url: feedUrl,
    site_url: parsed.siteUrl || siteUrl || null,
    title: body.title || parsed.title || domainOf(feedUrl) || feedUrl,
    description: parsed.description || null,
    favicon_url: faviconForUrl(parsed.siteUrl || siteUrl || feedUrl),
    category: body.category || null,
    importance: standardFeedImportance,
    auto_save_to_bucket: boolInt(body.auto_save_to_bucket),
    is_active: 1,
    fetch_interval_minutes: standardFeedRefreshMinutes,
    last_fetched_at: timestamp,
    last_success_at: timestamp,
    last_error: null,
    refresh_claimed_at: null,
    refresh_claim_id: null,
    created_at: timestamp,
    updated_at: timestamp
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feeds
       (id, feed_url, site_url, title, description, favicon_url, category, importance, auto_save_to_bucket, is_active, fetch_interval_minutes, last_fetched_at, last_success_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      feed.id, feed.feed_url, feed.site_url, feed.title, feed.description, feed.favicon_url, feed.category,
      feed.importance, feed.auto_save_to_bucket, feed.is_active, feed.fetch_interval_minutes, feed.last_fetched_at, feed.last_success_at,
      feed.last_error, feed.created_at, feed.updated_at
    ),
    ...selectFeedItemsForRefresh(parsed.items).map((item) => feedItemInsert(env, feed.id, item))
  ]);
  if (body.tags) {
    await setFeedTags(env, feed.id, body.tags);
    feed.tags = await getFeedTags(env, feed.id);
  } else {
    feed.tags = [];
  }

  await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json({ feed }, 201);
}

async function updateFeed(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson<Partial<Feed> & { tags?: string[] }>(request);
  const current = await env.DB.prepare("SELECT * FROM feeds WHERE id = ?").bind(id).first<Feed>();
  if (!current) return json({ error: "Feed not found" }, 404);
  const siteUrl = body.site_url === undefined ? current.site_url : safeParsedUrl(body.site_url || "", current.feed_url) || null;
  await env.DB.prepare(
    `UPDATE feeds SET title = ?, site_url = ?, category = ?, importance = ?, auto_save_to_bucket = ?, is_active = ?,
     fetch_interval_minutes = ?, updated_at = ? WHERE id = ?`
  ).bind(
    body.title ?? current.title,
    siteUrl,
    body.category ?? current.category,
    standardFeedImportance,
    body.auto_save_to_bucket === undefined ? current.auto_save_to_bucket : boolInt(body.auto_save_to_bucket),
    body.is_active ?? current.is_active,
    standardFeedRefreshMinutes,
    now(),
    id
  ).run();
  if (body.tags) await setFeedTags(env, id, body.tags);
  const feed = await env.DB.prepare("SELECT * FROM feeds WHERE id = ?").bind(id).first<Feed>();
  if (feed) feed.tags = await getFeedTags(env, id);
  await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json({ feed });
}

async function deleteFeed(request: Request, env: Env, id: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
  await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json({ ok: true });
}

async function bulkDeleteFeeds(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ feedIds?: unknown }>(request);
  const feedIds = uniqueIds(body.feedIds);
  if (feedIds.length === 0) return json({ error: "Feed IDs required" }, 400);

  const existingIds = await getExistingFeedIds(env, feedIds);
  for (const ids of chunks(existingIds, 90)) {
    const placeholders = ids.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM feeds WHERE id IN (${placeholders})`).bind(...ids).run();
  }

  if (existingIds.length > 0) await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json({ ok: true, deleted: existingIds.length });
}

async function bulkTagFeeds(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ feedIds?: unknown; tags?: unknown }>(request);
  const feedIds = uniqueIds(body.feedIds);
  const tags = Array.isArray(body.tags) ? uniqueTagNames(body.tags.filter((tag): tag is string => typeof tag === "string")) : [];
  if (feedIds.length === 0) return json({ error: "Feed IDs required" }, 400);
  if (tags.length === 0) return json({ error: "Tags required" }, 400);

  const existingIds = await getExistingFeedIds(env, feedIds);
  if (existingIds.length === 0) return json({ ok: true, updated: 0 });

  const tagRows: Array<{ id: string; name: string }> = [];
  for (const name of tags) tagRows.push(await ensureTag(env, name));

  for (const ids of chunks(existingIds, 90)) {
    await env.DB.batch(ids.flatMap((feedId) =>
      tagRows.map((tag) =>
        env.DB.prepare("INSERT OR IGNORE INTO feed_tags (feed_id, tag_id) VALUES (?, ?)")
          .bind(feedId, tag.id)
      )
    ));
  }

  await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json({ ok: true, updated: existingIds.length });
}

async function refreshFeedEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  const feed = await env.DB.prepare("SELECT * FROM feeds WHERE id = ?").bind(id).first<Feed>();
  if (!feed) return json({ error: "Feed not found" }, 404);
  const result = await refreshOneFeed(env, feed, request);
  return json(result);
}

async function refreshFeedBatchEndpoint(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ feedIds?: string[]; limit?: number; async?: boolean }>(request);
  if (body.async) return json(await queueRefreshBatch(env, ctx, body.feedIds, request));

  const limit = Math.max(1, Math.min(maxRefreshBatchSize, Number(body.limit) || maxRefreshBatchSize));
  let feeds: Feed[] = [];
  let claimedMessages: FeedRefreshMessage[] = [];

  if (Array.isArray(body.feedIds)) {
    const ids = body.feedIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, limit);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await env.DB.prepare(`SELECT * FROM feeds WHERE id IN (${placeholders}) AND is_active = 1`)
        .bind(...ids)
        .all<Feed>();
      feeds = rows.results || [];
    }
  } else {
    claimedMessages = await claimDueFeeds(env, limit);
  }

  const result: RefreshBatchResult = { refreshed: 0, inserted: 0, failed: 0, results: [] };
  for (const message of claimedMessages) {
    const feed = await env.DB.prepare("SELECT * FROM feeds WHERE id = ? AND is_active = 1").bind(message.feedId).first<Feed>();
    if (!feed || feed.refresh_claim_id !== message.claimId) continue;
    const refresh = await refreshOneFeed(env, feed, request);
    result.refreshed++;
    if (refresh.ok) result.inserted += refresh.inserted || 0;
    else result.failed++;
    result.results.push({ feedId: feed.id, ...refresh });
  }
  for (const feed of feeds) {
    const refresh = await refreshOneFeed(env, feed, request);
    result.refreshed++;
    if (refresh.ok) result.inserted += refresh.inserted || 0;
    else result.failed++;
    result.results.push({ feedId: feed.id, ...refresh });
  }
  return json(result);
}

async function queueRefreshBatch(
  env: Env,
  ctx: ExecutionContext,
  feedIds: unknown,
  request?: Request
): Promise<RefreshQueueResult> {
  const ids = Array.isArray(feedIds) ? uniqueStrings(feedIds) : [];
  if (ids.length === 0) return { queued: 0, skipped: 0, total: 0 };

  const messages = await claimFeedIdsForRefresh(env, ids);
  await enqueueRefreshMessages(env, ctx, messages);
  if (messages.length > 0) await publishAppInvalidation(env, ["river", "feeds"], request);
  return { queued: messages.length, skipped: ids.length - messages.length, total: ids.length };
}

async function claimFeedIdsForRefresh(env: Env, feedIds: string[]): Promise<FeedRefreshMessage[]> {
  const candidates = feedIds.map((feedId) => ({ feedId, claimId: crypto.randomUUID() }));
  const messages: FeedRefreshMessage[] = [];
  for (const batch of chunks(candidates, 90)) {
    const results = await env.DB.batch(batch.map((message) =>
      env.DB.prepare(
      `UPDATE feeds
       SET refresh_claimed_at = ?, refresh_claim_id = ?
       WHERE id = ?
         AND is_active = 1
         AND (refresh_claimed_at IS NULL OR datetime(refresh_claimed_at, '+${refreshClaimTtlMinutes} minutes') <= datetime('now'))`
      ).bind(now(), message.claimId, message.feedId)
    ));
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].meta.changes > 0) messages.push(batch[index]);
    }
  }
  return messages;
}

async function enqueueRefreshMessages(
  env: Env,
  ctx: ExecutionContext,
  messages: FeedRefreshMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  if (env.FEED_REFRESH_QUEUE) {
    for (const batch of chunks(messages, 100)) {
      await env.FEED_REFRESH_QUEUE.sendBatch(batch.map((message) => ({ body: message })));
    }
    return;
  }

  ctx.waitUntil((async () => {
    for (const message of messages) await processFeedRefreshMessage(env, message);
  })().catch((error) => {
    console.error("Background feed refresh failed", error);
  }));
}

async function getRiver(request: Request, env: Env): Promise<Response> {
  return json(await buildRiver(request, env));
}

async function startupRiver(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  ctx.waitUntil(enqueueDueFeeds(env, maxStartupRefreshEnqueues).catch(console.error));
  return json({ authenticated: true, river: await buildRiver(request, env) });
}

async function buildRiver(request: Request, env: Env): Promise<RiverResponse> {
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "title" ? "title" : "newest";
  const args: unknown[] = [];
  const where = ["is_active = 1"];
  if (url.searchParams.get("category")) {
    where.push("category = ?");
    args.push(url.searchParams.get("category"));
  }
  if (url.searchParams.get("tag")) {
    where.push("EXISTS (SELECT 1 FROM feed_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.feed_id = feeds.id AND t.name = ?)");
    args.push(url.searchParams.get("tag"));
  }
  if (url.searchParams.get("untagged") === "1") {
    where.push("NOT EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_id = feeds.id)");
  }
  const feeds = await env.DB.prepare(`SELECT * FROM feeds WHERE ${where.join(" AND ")} ORDER BY title COLLATE NOCASE`)
    .bind(...args)
    .all<Feed>();
  const feedRows = feeds.results || [];
  const feedIds = feedRows.map((feed) => feed.id);
  const tagsByFeed = await getFeedTagsMap(env, feedIds);
  for (const feed of feedRows) {
    normalizeFeedRecord(feed);
    feed.tags = tagsByFeed.get(feed.id) || [];
  }

  const [itemsByFeed, tags] = await Promise.all([
    getRecentFeedItemsMap(env, feedIds, maxRiverItemsPerFeed),
    listFeedTagRows(env)
  ]);
  const allItems = Array.from(itemsByFeed.values()).flat();
  for (const item of allItems) normalizeFeedItemRecord(item);
  const savedIds = await getSavedFeedItemIds(env, feedIds);
  for (const item of allItems) item.saved_id = savedIds.get(item.id) || savedIds.get(item.url) || null;

  const output = feedRows.map((feed) => ({ feed, items: itemsByFeed.get(feed.id) || [] }));
  if (sort === "newest") {
    output.sort((left, right) => {
      const leftLatest = latestFeedItemTime(left.items);
      const rightLatest = latestFeedItemTime(right.items);
      if (leftLatest && rightLatest && leftLatest !== rightLatest) return rightLatest.localeCompare(leftLatest);
      if (leftLatest && !rightLatest) return -1;
      if (!leftLatest && rightLatest) return 1;
      return left.feed.title.localeCompare(right.feed.title, undefined, { sensitivity: "base" });
    });
  }
  return { groups: output, tags };
}

function latestFeedItemTime(items: FeedItem[]): string | null {
  const item = items[0];
  return item ? item.published_at || item.discovered_at : null;
}

function parseCursor(value: string | null): { saved_at: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atobUrl(value)) as { saved_at?: unknown; id?: unknown };
    if (typeof decoded.saved_at !== "string" || typeof decoded.id !== "string") return null;
    return { saved_at: decoded.saved_at, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeCursor(savedAt: string, id: string): string {
  return btoaUrl(JSON.stringify({ saved_at: savedAt, id }));
}

async function saveFeedItem(request: Request, env: Env, itemId: string): Promise<Response> {
  const item = await env.DB.prepare("SELECT * FROM feed_items WHERE id = ?").bind(itemId).first<FeedItem>();
  if (!item) return json({ error: "Feed item not found" }, 404);
  const result = await upsertBookmark(env, {
    url: item.url,
    canonical_url: item.canonical_url,
    title: normalizeText(item.title),
    source: "rss_item",
    source_feed_id: item.feed_id,
    source_feed_item_id: item.id
  });
  if (result.created) await mergeBookmarkTags(env, result.bookmark.id, ["river"]);
  result.bookmark.tags = await getBookmarkTags(env, result.bookmark.id);
  await publishAppInvalidation(env, ["river", "bucket", "tags"], request);
  return json(bookmarkSaveResponse(result));
}

async function listBookmarks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const args: unknown[] = [];
  const where = ["b.status != 'deleted'"];
  const status = url.searchParams.get("status");
  const query = url.searchParams.get("q");
  const tag = url.searchParams.get("tag");
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const limit = Math.max(1, Math.min(maxBookmarkPageSize, Number(url.searchParams.get("limit")) || maxBookmarkPageSize));
  const page = Math.max(1, Number.isInteger(Number(url.searchParams.get("page"))) ? Number(url.searchParams.get("page")) : 1);
  if (status) {
    where.push("b.status = ?");
    args.push(status);
  }
  if (query) {
    where.push("(b.title LIKE ? OR b.domain LIKE ? OR b.url LIKE ?)");
    args.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.name = ?)");
    args.push(tag);
  }
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM bookmarks b WHERE ${where.join(" AND ")}`)
    .bind(...args)
    .first<{ total: number }>();
  const total = countRow?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (cursor) {
    where.push("(b.saved_at < ? OR (b.saved_at = ? AND b.id < ?))");
    args.push(cursor.saved_at, cursor.saved_at, cursor.id);
  }
  const rows = await env.DB.prepare(
    `SELECT b.*
     FROM bookmarks b
     WHERE ${where.join(" AND ")}
     ORDER BY b.saved_at DESC, b.id DESC
     LIMIT ?${cursor ? "" : " OFFSET ?"}`
  )
    .bind(...args, cursor ? limit + 1 : limit, ...(cursor ? [] : [(page - 1) * limit]))
    .all<Bookmark>();
  const results = rows.results || [];
  const bookmarks = cursor ? results.slice(0, limit) : results;
  const last = bookmarks[bookmarks.length - 1];
  const nextCursor = results.length > limit && last ? encodeCursor(last.saved_at, last.id) : null;
  const tagsByBookmark = await getBookmarkTagsMap(env, bookmarks.map((bookmark) => bookmark.id));
  for (const bookmark of bookmarks) bookmark.tags = tagsByBookmark.get(bookmark.id) || [];
  return json({ bookmarks, tags: await listTagRows(env), page, pageSize: limit, total, totalPages, nextCursor });
}

async function upsertBookmarkEndpoint(request: Request, env: Env, defaultSource: string): Promise<Response> {
  const body = await readJson<Partial<Bookmark> & { tags?: string[] }>(request);
  if (!body.url) return json({ error: "URL required" }, 400);
  const metadata = await fetchBookmarkMetadata(body.url);
  const result = await upsertBookmark(env, {
    ...body,
    url: metadata.finalUrl,
    title: body.title || metadata.title || body.link_text || metadata.finalUrl,
    source: body.source || defaultSource
  });
  if (body.tags) await setBookmarkTags(env, result.bookmark.id, body.tags);
  result.bookmark.tags = await getBookmarkTags(env, result.bookmark.id);
  await publishAppInvalidation(env, ["river", "bucket", "tags"], request);
  return json(bookmarkSaveResponse(result));
}

async function updateBookmark(request: Request, env: Env, id: string): Promise<Response> {
  const current = await env.DB.prepare("SELECT * FROM bookmarks WHERE id = ?").bind(id).first<Bookmark>();
  if (!current) return json({ error: "Bookmark not found" }, 404);
  const body = await readJson<Partial<Bookmark> & { tags?: string[] }>(request);
  await env.DB.prepare(
    `UPDATE bookmarks SET title = ?, description = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`
  ).bind(
    body.title ?? current.title,
    body.description ?? current.description,
    body.status ?? current.status,
    body.notes ?? current.notes,
    now(),
    id
  ).run();
  if (body.tags) await setBookmarkTags(env, id, body.tags);
  const bookmark = await env.DB.prepare("SELECT * FROM bookmarks WHERE id = ?").bind(id).first<Bookmark>();
  if (bookmark) bookmark.tags = await getBookmarkTags(env, id);
  await publishAppInvalidation(env, ["river", "bucket", "tags"], request);
  return json({ bookmark });
}

async function archiveBookmark(request: Request, env: Env, id: string): Promise<Response> {
  await env.DB.prepare("UPDATE bookmarks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
    .bind(now(), now(), id)
    .run();
  await publishAppInvalidation(env, ["bucket", "tags"], request);
  return json({ ok: true });
}

async function restoreBookmark(request: Request, env: Env, id: string): Promise<Response> {
  await env.DB.prepare("UPDATE bookmarks SET status = 'bucket', archived_at = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), id)
    .run();
  await publishAppInvalidation(env, ["bucket", "tags"], request);
  return json({ ok: true });
}

async function deleteBookmark(request: Request, env: Env, id: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM bookmark_tags WHERE bookmark_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(id).run();
  await publishAppInvalidation(env, ["river", "bucket", "tags"], request);
  return json({ ok: true });
}

async function listTags(env: Env): Promise<Response> {
  return json({ tags: await listTagRows(env) });
}

async function listTagRows(env: Env): Promise<Array<{ id: string; name: string }>> {
  const rows = await env.DB.prepare("SELECT * FROM tags ORDER BY name COLLATE NOCASE").all<{ id: string; name: string }>();
  return rows.results || [];
}

async function createTagEndpoint(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ name?: string }>(request);
  if (!body.name) return json({ error: "Tag name required" }, 400);
  const tag = await ensureTag(env, body.name);
  await publishAppInvalidation(env, ["tags"], request);
  return json({ tag }, 201);
}

async function setBookmarkTagsEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson<{ tags?: string[] }>(request);
  await setBookmarkTags(env, id, body.tags || []);
  await publishAppInvalidation(env, ["bucket", "tags"], request);
  return json({ tags: await getBookmarkTags(env, id) });
}

async function importOpml(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ opml?: string }>(request);
  if (!body.opml) return json({ error: "OPML text required" }, 400);
  const parsed = xmlParser.parse(body.opml) as Record<string, unknown>;
  const outlines = collectOutlines(parsed);
  const result = await importFeedBatch(env, outlines);
  if (result.imported > 0) await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json(result);
}

async function importOpmlFeeds(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ feeds?: ImportFeedInput[] }>(request);
  if (!Array.isArray(body.feeds)) return json({ error: "Feeds array required" }, 400);
  const result = await importFeedBatch(env, body.feeds);
  if (result.imported > 0) await publishAppInvalidation(env, ["river", "feeds", "feedTags"], request);
  return json(result);
}

async function importBookmarks(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ bookmarks?: ImportBookmarkInput[] }>(request);
  if (!Array.isArray(body.bookmarks)) return json({ error: "Bookmarks array required" }, 400);
  const result: ImportBookmarkBatchResult = { imported: 0, skipped: 0, ignored: 0, bookmarkIds: [] };

  for (const item of body.bookmarks) {
    const input = normalizeImportBookmark(item);
    if (!input) {
      result.ignored++;
      continue;
    }

    const saved = await upsertBookmark(env, input, { touchExisting: false });
    if (item.tags) await mergeBookmarkTags(env, saved.bookmark.id, item.tags);
    if (saved.created) {
      result.imported++;
      result.bookmarkIds.push(saved.bookmark.id);
    } else {
      result.skipped++;
    }
  }

  if (result.imported + result.skipped > 0) {
    await publishAppInvalidation(env, ["river", "bucket", "tags"], request);
  }
  return json(result);
}

async function importAllJson(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson<unknown>(request, largeImportJsonBodyMaxBytes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) throw error;
    return json({ error: "Could not parse that full JSON bundle." }, 400);
  }

  const bundle = parseFullJsonBundle(body);
  if (!bundle) return json({ error: "That JSON file does not look like a Riverbucket full export." }, 400);

  const result: ImportAllJsonResult = {
    feeds: emptyImportSummary(),
    feed_items: emptyImportSummary(),
    bookmarks: emptyImportSummary(),
    tags: emptyImportSummary(),
    bookmark_tags: emptyImportSummary(),
    feed_tags: emptyImportSummary()
  };
  const tagIds = new Map<string, string>();
  const feedIds = new Map<string, string>();
  const feedItemIds = new Map<string, string>();
  const bookmarkIds = new Map<string, string>();

  await importBundleTags(env, bundle.tags, result.tags, tagIds);
  await importBundleFeeds(env, bundle.feeds, result.feeds, feedIds);
  await importBundleFeedItems(env, bundle.feed_items, result.feed_items, feedIds, feedItemIds);
  await importBundleBookmarks(env, bundle.bookmarks, result.bookmarks, feedIds, feedItemIds, bookmarkIds);
  await importBundleBookmarkTags(env, bundle.bookmark_tags, result.bookmark_tags, bookmarkIds, tagIds);
  await importBundleFeedTags(env, bundle.feed_tags, result.feed_tags, feedIds, tagIds);

  if (Object.values(result).some((summary) => summary.imported > 0)) {
    await publishAppInvalidation(env, ["river", "bucket", "feeds", "feedTags", "tags"], request);
  }
  return json(result);
}

function parseFullJsonBundle(value: unknown): {
  feeds: unknown[];
  feed_items: unknown[];
  bookmarks: unknown[];
  tags: unknown[];
  bookmark_tags: unknown[];
  feed_tags: unknown[];
} | null {
  const row = importRow(value);
  if (!row) return null;
  if (
    !Array.isArray(row.feeds) ||
    !Array.isArray(row.feed_items) ||
    !Array.isArray(row.bookmarks) ||
    !Array.isArray(row.tags) ||
    !Array.isArray(row.bookmark_tags) ||
    !Array.isArray(row.feed_tags)
  ) {
    return null;
  }
  return {
    feeds: row.feeds,
    feed_items: row.feed_items,
    bookmarks: row.bookmarks,
    tags: row.tags,
    bookmark_tags: row.bookmark_tags,
    feed_tags: row.feed_tags
  };
}

async function importBundleTags(env: Env, rows: unknown[], summary: ImportTableSummary, tagIds: Map<string, string>): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const sourceId = row ? stringOrNull(row.id) : null;
    const name = row ? uniqueTagNames([stringOrNull(row.name) || ""])[0] : null;
    if (!row || !sourceId || !name) {
      summary.ignored++;
      continue;
    }

    const existingById = await env.DB.prepare("SELECT id FROM tags WHERE id = ?").bind(sourceId).first<{ id: string }>();
    if (existingById) {
      tagIds.set(sourceId, existingById.id);
      summary.skipped++;
      continue;
    }

    const existingByName = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first<{ id: string }>();
    if (existingByName) {
      tagIds.set(sourceId, existingByName.id);
      summary.skipped++;
      continue;
    }

    await env.DB.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").bind(sourceId, name).run();
    tagIds.set(sourceId, sourceId);
    summary.imported++;
  }
}

async function importBundleFeeds(env: Env, rows: unknown[], summary: ImportTableSummary, feedIds: Map<string, string>): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const sourceId = row ? stringOrNull(row.id) : null;
    const feedUrl = row ? normalizeFeedUrl(row.feed_url) : null;
    if (!row || !sourceId || !feedUrl) {
      summary.ignored++;
      continue;
    }

    const existingById = await env.DB.prepare("SELECT id FROM feeds WHERE id = ?").bind(sourceId).first<{ id: string }>();
    if (existingById) {
      feedIds.set(sourceId, existingById.id);
      summary.skipped++;
      continue;
    }

    const existingByUrl = await env.DB.prepare("SELECT id FROM feeds WHERE feed_url = ?").bind(feedUrl).first<{ id: string }>();
    if (existingByUrl) {
      feedIds.set(sourceId, existingByUrl.id);
      summary.skipped++;
      continue;
    }

    const timestamp = now();
    const createdAt = validIsoDate(row.created_at) || timestamp;
    const updatedAt = validIsoDate(row.updated_at) || createdAt;
    await env.DB.prepare(
      `INSERT INTO feeds
       (id, feed_url, site_url, title, description, favicon_url, category, importance, auto_save_to_bucket, is_active, fetch_interval_minutes, last_fetched_at, last_success_at, last_error, refresh_claimed_at, refresh_claim_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sourceId,
      feedUrl,
      normalizeImportedHttpUrl(row.site_url),
      normalizeText(stringOrNull(row.title) || importFeedTitle(row.title, feedUrl)),
      normalizeOptionalText(row.description) || null,
      normalizeImportedHttpUrl(row.favicon_url),
      stringOrNull(row.category),
      stringOrNull(row.importance) || standardFeedImportance,
      importIntegerFlag(row.auto_save_to_bucket, 0),
      importIntegerFlag(row.is_active, 1),
      positiveInteger(row.fetch_interval_minutes) || standardFeedRefreshMinutes,
      validIsoDate(row.last_fetched_at),
      validIsoDate(row.last_success_at),
      stringOrNull(row.last_error),
      null,
      null,
      createdAt,
      updatedAt
    ).run();
    feedIds.set(sourceId, sourceId);
    summary.imported++;
  }
}

async function importBundleFeedItems(
  env: Env,
  rows: unknown[],
  summary: ImportTableSummary,
  feedIds: Map<string, string>,
  feedItemIds: Map<string, string>
): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const sourceId = row ? stringOrNull(row.id) : null;
    const sourceFeedId = row ? stringOrNull(row.feed_id) : null;
    const feedId = sourceFeedId ? feedIds.get(sourceFeedId) : null;
    const url = row ? normalizeImportedHttpUrl(row.url) : null;
    if (!row || !sourceId || !sourceFeedId || !feedId || !url) {
      summary.ignored++;
      continue;
    }

    const existingById = await env.DB.prepare("SELECT id FROM feed_items WHERE id = ?").bind(sourceId).first<{ id: string }>();
    if (existingById) {
      feedItemIds.set(sourceId, existingById.id);
      summary.skipped++;
      continue;
    }

    const guid = stringOrNull(row.guid);
    const existingByIdentity = guid
      ? await env.DB.prepare("SELECT id FROM feed_items WHERE feed_id = ? AND (guid = ? OR url = ?) LIMIT 1")
        .bind(feedId, guid, url)
        .first<{ id: string }>()
      : await env.DB.prepare("SELECT id FROM feed_items WHERE feed_id = ? AND url = ? LIMIT 1")
        .bind(feedId, url)
        .first<{ id: string }>();
    if (existingByIdentity) {
      feedItemIds.set(sourceId, existingByIdentity.id);
      summary.skipped++;
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO feed_items
       (id, feed_id, guid, url, canonical_url, title, author, published_at, discovered_at, summary, raw_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sourceId,
      feedId,
      guid,
      url,
      normalizeImportedHttpUrl(row.canonical_url),
      normalizeText(stringOrNull(row.title) || url),
      normalizeOptionalText(row.author) || null,
      validIsoDate(row.published_at),
      validIsoDate(row.discovered_at) || now(),
      normalizeOptionalText(row.summary) || null,
      stringOrNull(row.raw_hash)
    ).run();
    feedItemIds.set(sourceId, sourceId);
    summary.imported++;
  }
}

async function importBundleBookmarks(
  env: Env,
  rows: unknown[],
  summary: ImportTableSummary,
  feedIds: Map<string, string>,
  feedItemIds: Map<string, string>,
  bookmarkIds: Map<string, string>
): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const sourceId = row ? stringOrNull(row.id) : null;
    const url = row ? normalizeImportedHttpUrl(row.url) : null;
    if (!row || !sourceId || !url) {
      summary.ignored++;
      continue;
    }

    const canonicalUrl = normalizeImportedHttpUrl(row.canonical_url);
    const dedupeUrl = stringOrNull(row.dedupe_url) || normalizeBookmarkUrl(canonicalUrl || url);
    const existing = await env.DB.prepare(
      "SELECT id FROM bookmarks WHERE id = ? OR dedupe_url = ? OR url = ? OR canonical_url = ? LIMIT 1"
    ).bind(sourceId, dedupeUrl, url, canonicalUrl || url).first<{ id: string }>();
    if (existing) {
      bookmarkIds.set(sourceId, existing.id);
      summary.skipped++;
      continue;
    }

    const timestamp = now();
    const savedAt = validIsoDate(row.saved_at) || timestamp;
    const status = row.status === "archived" ? "archived" : "bucket";
    const sourceFeedId = mapImportId(row.source_feed_id, feedIds);
    const sourceFeedItemId = mapImportId(row.source_feed_item_id, feedItemIds);
    await env.DB.prepare(
      `INSERT INTO bookmarks
       (id, url, canonical_url, dedupe_url, title, description, domain, status, source, source_feed_id, source_feed_item_id,
        source_page_url, source_page_title, link_text, notes, saved_at, archived_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sourceId,
      url,
      canonicalUrl,
      dedupeUrl,
      normalizeOptionalText(row.title) || url,
      normalizeOptionalText(row.description) || null,
      domainOf(url),
      status,
      stringOrNull(row.source) || "import",
      sourceFeedId,
      sourceFeedItemId,
      normalizeImportedHttpUrl(row.source_page_url),
      normalizeOptionalText(row.source_page_title) || null,
      normalizeOptionalText(row.link_text) || null,
      normalizeOptionalText(row.notes) || null,
      savedAt,
      status === "archived" ? validIsoDate(row.archived_at) : null,
      validIsoDate(row.updated_at) || savedAt
    ).run();
    bookmarkIds.set(sourceId, sourceId);
    summary.imported++;
  }
}

async function importBundleBookmarkTags(
  env: Env,
  rows: unknown[],
  summary: ImportTableSummary,
  bookmarkIds: Map<string, string>,
  tagIds: Map<string, string>
): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const bookmarkId = row ? mapImportId(row.bookmark_id, bookmarkIds) : null;
    const tagId = row ? mapImportId(row.tag_id, tagIds) : null;
    if (!row || !bookmarkId || !tagId) {
      summary.ignored++;
      continue;
    }

    const existing = await env.DB.prepare("SELECT 1 FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?")
      .bind(bookmarkId, tagId)
      .first();
    if (existing) {
      summary.skipped++;
      continue;
    }

    await env.DB.prepare("INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)")
      .bind(bookmarkId, tagId)
      .run();
    summary.imported++;
  }
}

async function importBundleFeedTags(
  env: Env,
  rows: unknown[],
  summary: ImportTableSummary,
  feedIds: Map<string, string>,
  tagIds: Map<string, string>
): Promise<void> {
  for (const value of rows) {
    const row = importRow(value);
    const feedId = row ? mapImportId(row.feed_id, feedIds) : null;
    const tagId = row ? mapImportId(row.tag_id, tagIds) : null;
    if (!row || !feedId || !tagId) {
      summary.ignored++;
      continue;
    }

    const existing = await env.DB.prepare("SELECT 1 FROM feed_tags WHERE feed_id = ? AND tag_id = ?")
      .bind(feedId, tagId)
      .first();
    if (existing) {
      summary.skipped++;
      continue;
    }

    await env.DB.prepare("INSERT INTO feed_tags (feed_id, tag_id) VALUES (?, ?)")
      .bind(feedId, tagId)
      .run();
    summary.imported++;
  }
}

function emptyImportSummary(): ImportTableSummary {
  return { imported: 0, skipped: 0, ignored: 0 };
}

function importRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeImportedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(absolutize(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function importIntegerFlag(value: unknown, fallback: number): number {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return fallback;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function mapImportId(value: unknown, ids: Map<string, string>): string | null {
  const sourceId = stringOrNull(value);
  return sourceId ? ids.get(sourceId) || null : null;
}

async function importFeedBatch(env: Env, feeds: ImportFeedInput[]): Promise<ImportFeedBatchResult> {
  let imported = 0;
  let skipped = 0;
  let ignored = 0;
  const feedIds: string[] = [];
  const seen = new Set<string>();

  for (const feedInput of feeds) {
    const feedUrl = normalizeFeedUrl(feedInput.feedUrl);
    if (!feedUrl) {
      ignored++;
      continue;
    }
    if (seen.has(feedUrl)) {
      skipped++;
      continue;
    }
    seen.add(feedUrl);

    const existing = await env.DB.prepare("SELECT id FROM feeds WHERE feed_url = ?").bind(feedUrl).first();
    if (existing) {
      skipped++;
      continue;
    }

    const timestamp = now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO feeds
       (id, feed_url, site_url, title, description, favicon_url, category, importance, auto_save_to_bucket, is_active, fetch_interval_minutes, last_fetched_at, last_success_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
	      feedUrl,
	      null,
	      importFeedTitle(feedInput.title, feedUrl),
	      null,
	      faviconForUrl(feedUrl),
      null,
      standardFeedImportance,
      0,
      1,
      standardFeedRefreshMinutes,
      null,
      null,
      null,
      timestamp,
      timestamp
    ).run();
    imported++;
    feedIds.push(id);
  }
  return { imported, skipped, ignored, feedIds };
}

async function exportOpml(request: Request, env: Env): Promise<Response> {
  const guard = requireExportConfirmation(request);
  if (guard) return guard;
  const rows = await env.DB.prepare("SELECT * FROM feeds WHERE is_active = 1 ORDER BY title COLLATE NOCASE").all<Feed>();
  const outlines = (rows.results || []).map((feed) =>
    `    <outline text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" type="rss" xmlUrl="${escapeXml(feed.feed_url)}"${feed.site_url ? ` htmlUrl="${escapeXml(feed.site_url)}"` : ""} />`
  ).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Riverbucket feeds</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`, {
    headers: { "content-type": "application/xml; charset=utf-8" }
  });
}

async function exportBookmarksJson(request: Request, env: Env): Promise<Response> {
  const guard = requireExportConfirmation(request);
  if (guard) return guard;
  const rows = await env.DB.prepare("SELECT * FROM bookmarks WHERE status != 'deleted' ORDER BY saved_at DESC").all<Bookmark>();
  return json({ bookmarks: rows.results || [] });
}

async function exportBookmarksHtml(request: Request, env: Env): Promise<Response> {
  const guard = requireExportConfirmation(request);
  if (guard) return guard;
  const rows = await env.DB.prepare("SELECT * FROM bookmarks WHERE status != 'deleted' ORDER BY saved_at DESC").all<Bookmark>();
  const items = (rows.results || []).map((bookmark) =>
    `<DT><A HREF="${escapeXml(bookmark.url)}" ADD_DATE="${Math.floor(new Date(bookmark.saved_at).getTime() / 1000)}">${escapeXml(bookmark.title || bookmark.url)}</A>`
  ).join("\n");
  return new Response(`<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Riverbucket bookmarks</TITLE>\n<H1>Riverbucket bookmarks</H1>\n<DL><p>\n${items}\n</DL><p>\n`, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

async function exportAllJson(request: Request, env: Env): Promise<Response> {
  const guard = requireExportConfirmation(request);
  if (guard) return guard;
  const [feeds, items, bookmarks, tags, bookmarkTags, feedTags] = await Promise.all([
    env.DB.prepare("SELECT * FROM feeds").all(),
    env.DB.prepare("SELECT * FROM feed_items").all(),
    env.DB.prepare("SELECT * FROM bookmarks").all(),
    env.DB.prepare("SELECT * FROM tags").all(),
    env.DB.prepare("SELECT * FROM bookmark_tags").all(),
    env.DB.prepare("SELECT * FROM feed_tags").all()
  ]);
  return json({
    exported_at: now(),
    feeds: feeds.results,
    feed_items: items.results,
    bookmarks: bookmarks.results,
    tags: tags.results,
    bookmark_tags: bookmarkTags.results,
    feed_tags: feedTags.results
  });
}

function requireExportConfirmation(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.searchParams.get("confirm") === "1") return null;
  return json({ error: "Export requires confirmation", confirm: "Append ?confirm=1 to run this full export." }, 409);
}

async function listExtensionTokens(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, label, created_at, last_used_at, revoked_at FROM extension_tokens ORDER BY created_at DESC"
  ).all();
  return json({ tokens: rows.results || [] });
}

async function createExtensionToken(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ label?: string }>(request);
  const token = `rb_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO extension_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)"
  ).bind(id, await sha256(token), body.label || "Extension", now()).run();
  await publishAppInvalidation(env, ["extensionTokens"], request);
  return json({ token: { id, label: body.label || "Extension", created_at: now() }, secret: token }, 201);
}

async function revokeExtensionToken(request: Request, env: Env, id: string): Promise<Response> {
  await env.DB.prepare("UPDATE extension_tokens SET revoked_at = ? WHERE id = ?").bind(now(), id).run();
  await publishAppInvalidation(env, ["extensionTokens"], request);
  return json({ ok: true });
}

async function saveExtensionLink(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Partial<Bookmark> & { tags?: string[] }>(request);
  if (!body.url) return json({ error: "URL required" }, 400);
  const metadata = await fetchBookmarkMetadata(body.url);
  const result = await upsertBookmark(env, {
    url: metadata.finalUrl,
    title: body.title || metadata.title || body.link_text || metadata.finalUrl,
    source: "extension",
    source_page_url: body.source_page_url || null,
    source_page_title: body.source_page_title || null,
    link_text: body.link_text || null
  });
  if (body.tags) await setBookmarkTags(env, result.bookmark.id, body.tags);
  result.bookmark.tags = await getBookmarkTags(env, result.bookmark.id);
  await publishAppInvalidation(env, ["river", "bucket", "tags"]);
  return json(bookmarkSaveResponse(result));
}

async function extensionSubscribe(request: Request, env: Env): Promise<Response> {
  return createFeed(request, env);
}

async function refreshDueFeeds(env: Env): Promise<void> {
  const refreshed = await enqueueDueFeeds(env, maxCronRefreshEnqueues);
  if (refreshed > 0) console.log(JSON.stringify({ event: "refreshDueFeeds", enqueued: refreshed }));
}

async function enqueueDueFeeds(env: Env, limit: number): Promise<number> {
  const claimLimit = env.FEED_REFRESH_QUEUE ? limit : Math.min(limit, maxRefreshBatchSize);
  const messages = await claimDueFeeds(env, claimLimit);
  if (messages.length === 0) return 0;
  await publishAppInvalidation(env, ["river", "feeds"]);

  if (env.FEED_REFRESH_QUEUE) {
    await env.FEED_REFRESH_QUEUE.sendBatch(messages.map((message) => ({ body: message })));
    return messages.length;
  }

  for (const message of messages) await processFeedRefreshMessage(env, message);
  return messages.length;
}

async function claimDueFeeds(env: Env, limit: number): Promise<FeedRefreshMessage[]> {
  const rows = await env.DB.prepare(
    `SELECT feeds.id
     FROM feeds
     LEFT JOIN (
       SELECT feed_id, MAX(COALESCE(published_at, discovered_at)) AS latest_item_time
       FROM feed_items
       GROUP BY feed_id
     ) latest ON latest.feed_id = feeds.id
     WHERE ${claimableDueFeedRefreshWhere}
     ORDER BY ${dueFeedClaimOrderBy}
     LIMIT ?`
  ).bind(limit).all<{ id: string }>();
  const messages: FeedRefreshMessage[] = [];

  for (const row of rows.results || []) {
    const claimId = crypto.randomUUID();
    const result = await env.DB.prepare(
      `UPDATE feeds
       SET refresh_claimed_at = ?, refresh_claim_id = ?
       WHERE id = ? AND ${claimableDueFeedRefreshWhere}`
    ).bind(now(), claimId, row.id).run();
    if (result.meta.changes > 0) messages.push({ feedId: row.id, claimId });
  }

  return messages;
}

async function processFeedRefreshMessage(env: Env, message: FeedRefreshMessage): Promise<void> {
  const feed = await env.DB.prepare("SELECT * FROM feeds WHERE id = ? AND is_active = 1").bind(message.feedId).first<Feed>();
  if (!feed) return;
  if (message.claimId && feed.refresh_claim_id !== message.claimId) return;
  if (!message.claimId && feed.refresh_claim_id) return;
  await refreshOneFeed(env, feed);
}

async function refreshOneFeed(
  env: Env,
  feed: Feed,
  request?: Request
): Promise<{ ok: boolean; inserted?: number; error?: string }> {
  try {
    const parsed = await fetchAndParseFeed(feed.feed_url);
    let inserted = 0;
    for (const item of selectFeedItemsForRefresh(parsed.items)) {
      const result = await upsertFeedItem(env, feed.id, item);
      if (result.created) {
        inserted += 1;
        if (feed.auto_save_to_bucket) {
          const saved = await upsertBookmark(env, {
            url: item.url,
            title: item.title,
            source: "rss_item",
            source_feed_id: feed.id,
            source_feed_item_id: result.id
          });
          if (saved.created) await mergeBookmarkTags(env, saved.bookmark.id, ["autoriver"]);
        }
      }
    }
    await pruneFeedItems(env, feed.id, maxFeedRefreshItems);
    const faviconUrl = faviconForUrl(parsed.siteUrl || feed.site_url || feed.feed_url);
    await env.DB.prepare(
      "UPDATE feeds SET title = ?, description = ?, site_url = COALESCE(?, site_url), favicon_url = COALESCE(favicon_url, ?), last_fetched_at = ?, last_success_at = ?, last_error = NULL, refresh_claimed_at = NULL, refresh_claim_id = NULL, updated_at = ? WHERE id = ?"
    ).bind(parsed.title || feed.title, parsed.description || feed.description, parsed.siteUrl || null, faviconUrl, now(), now(), now(), feed.id).run();
    await publishAppInvalidation(env, ["river", "feeds", "bucket", "tags"], request);
    return { ok: true, inserted };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refresh failed";
    await env.DB.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = ?, refresh_claimed_at = NULL, refresh_claim_id = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), message, now(), feed.id)
      .run();
    await publishAppInvalidation(env, ["river", "feeds"], request);
    return { ok: false, error: message };
  }
}

async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  const safeFeedUrl = normalizePublicHttpUrl(feedUrl);
  const response = await safeFetch(safeFeedUrl, { headers: { "user-agent": "Riverbucket/0.1" } });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const text = await readLimitedText(response, outboundFeedMaxBytes);
  if (contentType.includes("json") || text.trim().startsWith("{")) return parseJsonFeed(text, safeFeedUrl);
  return parseXmlFeed(text, safeFeedUrl);
}

async function discoverFeeds(inputUrl: string): Promise<FeedCandidate[]> {
  const siteUrl = normalizePublicHttpUrl(inputUrl);
  const response = await safeFetch(siteUrl, { headers: { "user-agent": "Riverbucket/0.1" } });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const finalUrl = normalizePublicHttpUrl(response.url || siteUrl);
  const contentType = response.headers.get("content-type") || "";
  const text = await readLimitedText(response, outboundPageMaxBytes);
  if (contentType.includes("xml") || contentType.includes("rss") || contentType.includes("atom") || text.trim().startsWith("<rss") || text.trim().startsWith("<feed")) {
    return [{ title: domainOf(finalUrl) || finalUrl, feedUrl: finalUrl, siteUrl: finalUrl, type: contentType, confidence: "primary" }];
  }
  const candidates: FeedCandidate[] = [];
  const linkPattern = /<link\b([^>]+)>/gi;
  for (const match of text.matchAll(linkPattern)) {
    const attrs = parseHtmlAttrs(match[1]);
    const rel = attrs.rel?.toLowerCase() || "";
    const type = attrs.type?.toLowerCase() || "";
    if (!rel.includes("alternate")) continue;
    if (!type.includes("rss") && !type.includes("atom") && !type.includes("json")) continue;
    if (!attrs.href) continue;
    const feedUrl = safeParsedUrl(attrs.href, finalUrl);
    if (!feedUrl) continue;
    candidates.push({
      title: attrs.title || (type.includes("atom") ? "Atom feed" : type.includes("json") ? "JSON feed" : "RSS feed"),
      feedUrl,
      siteUrl: finalUrl,
      type,
      confidence: "alternate",
      source: "html"
    });
  }
  candidates.push(...discoverKnownSiteFeeds(finalUrl, text));
  if (candidates.length === 0) {
    candidates.push(...await discoverCommonFeedPaths(finalUrl));
  }
  const seen = new Set<string>();
  return candidates.sort(feedCandidateRank).filter((candidate) => {
    const key = normalizeFeedCandidateUrl(candidate.feedUrl);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function discoverKnownSiteFeeds(finalUrl: string, htmlText: string): FeedCandidate[] {
  const candidates: FeedCandidate[] = [];
  const url = new URL(finalUrl);
  const host = url.hostname.toLowerCase();
  const lowerHtml = htmlText.toLowerCase();

  const add = (title: string, value: string, type = "application/rss+xml", confidence: "primary" | "alternate" = "primary") => {
    const feedUrl = safeParsedUrl(value, finalUrl);
    if (!feedUrl) return;
    candidates.push({ title, feedUrl, siteUrl: finalUrl, type, confidence, source: "known-site" });
  };
  const addOriginPath = (title: string, pathname: string, type = "application/rss+xml") => {
    add(title, new URL(pathname, url.origin).toString(), type);
  };

  const isWordPress = lowerHtml.includes("wp-content/") || lowerHtml.includes("wp-includes/") || lowerHtml.includes("generator\" content=\"wordpress");
  const isSubstack = host.endsWith(".substack.com") || lowerHtml.includes("substackcdn.com") || lowerHtml.includes("substack-post-media");
  const isTumblr = host.endsWith(".tumblr.com") || lowerHtml.includes("assets.tumblr.com") || lowerHtml.includes("tumblr-theme");
  const isGhost = lowerHtml.includes("ghost.org") || lowerHtml.includes("content=\"ghost") || lowerHtml.includes("/ghost/api/") || lowerHtml.includes("ghost/content/");
  const isBlogger = host.endsWith(".blogspot.com") || lowerHtml.includes("blogger.com") || lowerHtml.includes("blogspot.com") || lowerHtml.includes("generator\" content=\"blogger");
  const isMedium = host === "medium.com" || host.endsWith(".medium.com") || lowerHtml.includes("miro.medium.com") || lowerHtml.includes("cdn-client.medium.com");
  const isMastodon = lowerHtml.includes("mastodon") || lowerHtml.includes("activitypub") || lowerHtml.includes('property="profile:username"');

  if (isTumblr) addOriginPath("Tumblr RSS feed", "/rss");
  if (isSubstack) addOriginPath("Substack feed", "/feed");
  if (isWordPress) addOriginPath("WordPress feed", "/feed/");
  if (isGhost) add("Ghost RSS feed", ghostFeedPath(url));
  if (isBlogger) addOriginPath("Blogger feed", "/feeds/posts/default", "application/atom+xml");

  addYouTubeKnownFeeds(url, htmlText, add);
  if (isMedium) addMediumKnownFeeds(url, add);
  if (isMastodon) addMastodonKnownFeeds(url, add);
  addRedditKnownFeeds(url, add);
  addGitHubKnownFeeds(url, add);

  return candidates;
}

function addYouTubeKnownFeeds(url: URL, htmlText: string, add: (title: string, value: string, type?: string, confidence?: "primary" | "alternate") => void): void {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return;
  const playlistId = url.searchParams.get("list");
  if (playlistId) {
    add("YouTube playlist feed", `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`, "application/atom+xml");
    return;
  }
  const channelId =
    url.pathname.match(/^\/channel\/([A-Za-z0-9_-]+)/)?.[1] ||
    htmlText.match(/"channelId"\s*:\s*"([^"]+)"/)?.[1] ||
    htmlText.match(/"externalId"\s*:\s*"([^"]+)"/)?.[1] ||
    htmlText.match(/https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/)?.[1];
  if (channelId) add("YouTube channel feed", `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, "application/atom+xml");
}

function addMediumKnownFeeds(url: URL, add: (title: string, value: string, type?: string, confidence?: "primary" | "alternate") => void): void {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "medium.com") {
    if (segments[0]?.startsWith("@")) {
      add("Medium profile feed", new URL(`/feed/${segments[0]}`, url.origin).toString());
      return;
    }
    if (segments[0] === "tag" && segments[1]) {
      add("Medium tag feed", new URL(`/feed/tag/${segments[1]}`, url.origin).toString());
      return;
    }
    if (segments[0] && !["feed", "p", "search", "me", "m"].includes(segments[0])) {
      add("Medium publication feed", new URL(`/feed/${segments[0]}`, url.origin).toString());
    }
    return;
  }
  add("Medium publication feed", new URL("/feed", url.origin).toString());
}

function addMastodonKnownFeeds(url: URL, add: (title: string, value: string, type?: string, confidence?: "primary" | "alternate") => void): void {
  if (!/^\/@[A-Za-z0-9_]+\/?$/.test(url.pathname)) return;
  add("Mastodon account RSS feed", `${url.origin}${url.pathname.replace(/\/$/, "")}.rss`);
}

function addRedditKnownFeeds(url: URL, add: (title: string, value: string, type?: string, confidence?: "primary" | "alternate") => void): void {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "reddit.com" && host !== "old.reddit.com") return;
  const isListing = /^\/(r|user|u)\/[^/]+(?:\/(?:new|hot|top|controversial|comments|submitted|saved|upvoted|downvoted|gilded))?\/?$/i.test(url.pathname);
  const isPostListing = /^\/r\/[^/]+\/comments\/[^/]+(?:\/[^/]+)?\/?$/i.test(url.pathname);
  if (!isListing && !isPostListing) return;
  add("Reddit RSS feed", `${url.origin}${url.pathname.replace(/\/$/, "")}.rss${url.search}`, "application/rss+xml", "alternate");
}

function addGitHubKnownFeeds(url: URL, add: (title: string, value: string, type?: string, confidence?: "primary" | "alternate") => void): void {
  const host = url.hostname.toLowerCase();
  if (host !== "github.com") return;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return;
  const [owner, repo, area, ...rest] = segments;
  const base = `https://github.com/${owner}/${repo}`;
  if (area === "releases") add("GitHub releases Atom feed", `${base}/releases.atom`, "application/atom+xml");
  if (area === "tags") add("GitHub tags Atom feed", `${base}/tags.atom`, "application/atom+xml");
  if (area === "commits") add("GitHub commits Atom feed", rest[0] ? `${base}/commits/${encodeGitHubPath(rest)}.atom` : `${base}/commits.atom`, "application/atom+xml");
  if (area === "tree" && rest[0]) add("GitHub branch commits Atom feed", `${base}/commits/${encodeGitHubPath(rest)}.atom`, "application/atom+xml");
}

function encodeGitHubPath(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function ghostFeedPath(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  if ((segments[0] === "tag" || segments[0] === "author") && segments[1]) return `${url.origin}/${segments[0]}/${segments[1]}/rss/`;
  return new URL("/rss/", url.origin).toString();
}

function feedCandidateRank(left: FeedCandidate, right: FeedCandidate): number {
  return feedCandidatePriority(left) - feedCandidatePriority(right);
}

function feedCandidatePriority(candidate: FeedCandidate): number {
  if (candidate.confidence === "primary" && candidate.source === "known-site") return 0;
  if (candidate.confidence === "primary") return 1;
  if (candidate.source === "html") return 2;
  if (candidate.source === "common-path") return 3;
  return 4;
}

function normalizeFeedCandidateUrl(feedUrl: string): string | null {
  try {
    return normalizePublicHttpUrl(feedUrl);
  } catch {
    return null;
  }
}

async function discoverCommonFeedPaths(siteUrl: string): Promise<FeedCandidate[]> {
  const candidates: FeedCandidate[] = [];
  for (const path of commonFeedPaths) {
    const feedUrl = safeParsedUrl(path, siteUrl);
    if (!feedUrl) continue;
    try {
      const response = await safeFetch(feedUrl, { headers: { "user-agent": "Riverbucket/0.1" } });
      if (!response.ok) continue;
      const finalUrl = normalizePublicHttpUrl(response.url || feedUrl);
      const contentType = response.headers.get("content-type") || "";
      const text = await readLimitedText(response, outboundFeedMaxBytes);
      const trimmed = text.trimStart();
      if (
        !contentType.includes("xml") &&
        !contentType.includes("rss") &&
        !contentType.includes("atom") &&
        !contentType.includes("json") &&
        !trimmed.startsWith("<rss") &&
        !trimmed.startsWith("<feed") &&
        !trimmed.startsWith("{")
      ) {
        continue;
      }
      candidates.push({
        title: domainOf(finalUrl) || finalUrl,
        feedUrl: finalUrl,
        siteUrl,
        type: contentType,
        confidence: "alternate",
        source: "common-path"
      });
    } catch {
      continue;
    }
  }
  return candidates;
}

function parseXmlFeed(text: string, feedUrl: string): ParsedFeed {
  const doc = xmlParser.parse(text) as any;
  if (doc.rss?.channel) {
    const channel = doc.rss.channel;
    const items = arrayify(channel.item).flatMap((item: any) => {
      const url = safeParsedUrl(firstLink(item.link), feedUrl);
      const title = textOf(item.title) || firstLink(item.link);
      return url && title ? [{
        guid: textOf(item.guid) || item.link,
        url,
        title,
        author: textOf(item.author) || textOf(item["dc:creator"]),
        publishedAt: normalizeDate(textOf(item.pubDate) || textOf(item.published) || textOf(item.updated)),
        summary: textOf(item.description) || textOf(item.summary)
      }] : [];
    });
    return {
      title: textOf(channel.title) || domainOf(feedUrl) || feedUrl,
      description: textOf(channel.description),
      siteUrl: safeParsedUrl(firstLink(channel.link), feedUrl),
      items
    };
  }
  if (doc.feed) {
    const feed = doc.feed;
    const items = arrayify(feed.entry).flatMap((entry: any) => {
      const url = safeParsedUrl(firstLink(entry.link), feedUrl);
      const title = textOf(entry.title) || firstLink(entry.link);
      return url && title ? [{
        guid: textOf(entry.id) || firstLink(entry.link),
        url,
        title,
        author: textOf(entry.author?.name),
        publishedAt: normalizeDate(textOf(entry.published) || textOf(entry.updated)),
        summary: textOf(entry.summary) || textOf(entry.content)
      }] : [];
    });
    return {
      title: textOf(feed.title) || domainOf(feedUrl) || feedUrl,
      description: textOf(feed.subtitle),
      siteUrl: safeParsedUrl(firstLink(feed.link), feedUrl),
      items
    };
  }
  throw new Error("Unsupported feed format");
}

function parseJsonFeed(text: string, feedUrl: string): ParsedFeed {
  const feed = JSON.parse(text) as any;
  return {
    title: normalizeText(feed.title || "JSON Feed"),
    description: normalizeOptionalText(feed.description),
    siteUrl: safeParsedUrl(feed.home_page_url, feedUrl),
    items: arrayify(feed.items).flatMap((item: any) => {
      const rawUrl = item.url || item.external_url;
      const url = safeParsedUrl(rawUrl, feedUrl);
      const title = normalizeText(item.title || rawUrl);
      return url && title ? [{
        guid: normalizeOptionalText(item.id),
        url,
        title,
        author: normalizeOptionalText(item.author?.name),
        publishedAt: normalizeDate(item.date_published || item.date_modified),
        summary: normalizeOptionalText(item.summary || item.content_text)
      }] : [];
    })
  };
}

export function selectFeedItemsForRefresh(items: ParsedFeed["items"]): ParsedFeed["items"] {
  return items
    .map((item, index) => ({ item, index, publishedTime: validTime(item.publishedAt) }))
    .sort((left, right) => {
      if (left.publishedTime !== null && right.publishedTime !== null && left.publishedTime !== right.publishedTime) {
        return right.publishedTime - left.publishedTime;
      }
      if (left.publishedTime !== null && right.publishedTime === null) return -1;
      if (left.publishedTime === null && right.publishedTime !== null) return 1;
      return left.index - right.index;
    })
    .slice(0, maxFeedRefreshItems)
    .map(({ item }) => item);
}

function validTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function feedItemInsert(env: Env, feedId: string, item: ParsedFeed["items"][number]): D1PreparedStatement {
  return feedItemInsertWithId(env, feedId, item).statement;
}

function feedItemInsertWithId(env: Env, feedId: string, item: ParsedFeed["items"][number]): { id: string; statement: D1PreparedStatement } {
  const timestamp = now();
  const id = crypto.randomUUID();
  const normalized = normalizeParsedFeedItem(item);
  const statement = env.DB.prepare(
    `INSERT OR IGNORE INTO feed_items
     (id, feed_id, guid, url, canonical_url, title, author, published_at, discovered_at, summary, raw_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    feedId,
    normalized.guid || normalized.url,
    normalized.url,
    null,
    normalized.title || normalized.url,
    normalized.author || null,
    normalized.publishedAt || null,
    timestamp,
    normalized.summary || null,
    null
  );
  return { id, statement };
}

async function upsertFeedItem(env: Env, feedId: string, item: ParsedFeed["items"][number]): Promise<{ id: string; created: boolean }> {
  const timestamp = now();
  const normalized = normalizeParsedFeedItem(item);
  const guid = normalized.guid || normalized.url;
  const existing = await env.DB.prepare(
    `SELECT id FROM feed_items
     WHERE feed_id = ? AND (guid = ? OR url = ?)
     ORDER BY CASE WHEN guid = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(feedId, guid, normalized.url, guid).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE feed_items
       SET guid = ?, url = ?, title = ?, author = COALESCE(?, author), published_at = COALESCE(?, published_at), summary = COALESCE(?, summary), raw_hash = ?
       WHERE id = ?`
    ).bind(
      guid,
      normalized.url,
      normalized.title || normalized.url,
      normalized.author || null,
      normalized.publishedAt || null,
      normalized.summary || null,
      null,
      existing.id
    ).run();
    return { id: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO feed_items
     (id, feed_id, guid, url, canonical_url, title, author, published_at, discovered_at, summary, raw_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    feedId,
    guid,
    normalized.url,
    null,
    normalized.title || normalized.url,
    normalized.author || null,
    normalized.publishedAt || null,
    timestamp,
    normalized.summary || null,
    null
  ).run();
  return { id, created: true };
}

async function pruneFeedItems(env: Env, feedId: string, keep: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM feed_items WHERE feed_id = ? AND id NOT IN (
      SELECT id FROM feed_items WHERE feed_id = ? ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT ?
    )`
  ).bind(feedId, feedId, keep).run();
}

async function upsertBookmark(env: Env, input: Partial<Bookmark> & { url: string }, options: { touchExisting?: boolean } = {}): Promise<BookmarkSaveResult> {
  const url = absolutize(input.url);
  const dedupeUrl = normalizeBookmarkUrl(input.canonical_url || url);
  const existing = await findExistingBookmark(env, url, dedupeUrl);
  const timestamp = now();
  const touchExisting = options.touchExisting !== false;
  if (existing) {
    const title = input.title || null;
    const shouldUpdateTitle = Boolean(title && (!existing.title || existing.title === existing.url || existing.title === existing.link_text));
    await env.DB.prepare(
      `UPDATE bookmarks SET
       title = CASE WHEN ? = 1 THEN ? ELSE title END, description = COALESCE(description, ?), canonical_url = COALESCE(canonical_url, ?),
       dedupe_url = COALESCE(dedupe_url, ?),
       source_feed_id = COALESCE(source_feed_id, ?), source_feed_item_id = COALESCE(source_feed_item_id, ?),
       source_page_url = COALESCE(source_page_url, ?), source_page_title = COALESCE(source_page_title, ?),
       link_text = COALESCE(link_text, ?),
       status = CASE WHEN ? = 1 THEN 'bucket' ELSE status END,
       saved_at = CASE WHEN ? = 1 THEN ? ELSE saved_at END,
       archived_at = CASE WHEN ? = 1 THEN NULL ELSE archived_at END,
       updated_at = ? WHERE id = ?`
    ).bind(
      shouldUpdateTitle ? 1 : 0,
      title,
      input.description || null,
      input.canonical_url || null,
      dedupeUrl,
      input.source_feed_id || null,
      input.source_feed_item_id || null,
      input.source_page_url || null,
      input.source_page_title || null,
      input.link_text || null,
      touchExisting ? 1 : 0,
      touchExisting ? 1 : 0,
      timestamp,
      touchExisting ? 1 : 0,
      timestamp,
      existing.id
    ).run();
    return { bookmark: (await env.DB.prepare("SELECT * FROM bookmarks WHERE id = ?").bind(existing.id).first<Bookmark>())!, created: false };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookmarks
     (id, url, canonical_url, dedupe_url, title, description, domain, status, source, source_feed_id, source_feed_item_id,
      source_page_url, source_page_title, link_text, notes, saved_at, archived_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    url,
    input.canonical_url || null,
    dedupeUrl,
    input.title || input.link_text || url,
    input.description || null,
    domainOf(url),
    input.status || "bucket",
    input.source || "manual",
    input.source_feed_id || null,
    input.source_feed_item_id || null,
    input.source_page_url || null,
    input.source_page_title || null,
    input.link_text || null,
    input.notes || null,
    input.saved_at || timestamp,
    input.archived_at || null,
    timestamp
  ).run();
  return { bookmark: (await env.DB.prepare("SELECT * FROM bookmarks WHERE id = ?").bind(id).first<Bookmark>())!, created: true };
}

async function findExistingBookmark(env: Env, url: string, dedupeUrl: string): Promise<Bookmark | null> {
  const existing = await env.DB.prepare("SELECT * FROM bookmarks WHERE dedupe_url = ? OR url = ? OR canonical_url = ? LIMIT 1")
    .bind(dedupeUrl, url, url)
    .first<Bookmark>();
  if (existing) return existing;

  const domain = domainOf(url);
  if (!domain) return null;
  const rows = await env.DB.prepare("SELECT * FROM bookmarks WHERE domain = ? AND status != 'deleted' ORDER BY saved_at DESC LIMIT 500")
    .bind(domain)
    .all<Bookmark>();
  return (rows.results || []).find((bookmark) => normalizeBookmarkUrl(bookmark.canonical_url || bookmark.url) === dedupeUrl) || null;
}

function bookmarkSaveResponse(result: BookmarkSaveResult): { bookmark: Bookmark; created: boolean; duplicate: boolean } {
  return {
    bookmark: result.bookmark,
    created: result.created,
    duplicate: !result.created
  };
}

async function ensureTag(env: Env, name: string): Promise<{ id: string; name: string }> {
  const normalized = name.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT * FROM tags WHERE name = ?").bind(normalized).first<{ id: string; name: string }>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)").bind(id, normalized).run();
  return (await env.DB.prepare("SELECT * FROM tags WHERE name = ?").bind(normalized).first<{ id: string; name: string }>()) || { id, name: normalized };
}

async function setBookmarkTags(env: Env, bookmarkId: string, names: string[]): Promise<void> {
  await setRelationTags(env, "bookmark_tags", "bookmark_id", bookmarkId, names, "replace");
}

async function mergeBookmarkTags(env: Env, bookmarkId: string, names: string[]): Promise<void> {
  await setRelationTags(env, "bookmark_tags", "bookmark_id", bookmarkId, names, "merge");
}

async function getBookmarkTags(env: Env, bookmarkId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT t.name FROM tags t JOIN bookmark_tags bt ON bt.tag_id = t.id WHERE bt.bookmark_id = ? ORDER BY t.name"
  ).bind(bookmarkId).all<{ name: string }>();
  return (rows.results || []).map((row) => row.name);
}

async function getBookmarkTagsMap(env: Env, bookmarkIds: string[]): Promise<Map<string, string[]>> {
  const output = new Map<string, string[]>();
  for (const id of bookmarkIds) output.set(id, []);
  for (const ids of chunks(bookmarkIds, 90)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT bt.bookmark_id, t.name
       FROM bookmark_tags bt
       JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id IN (${placeholders})
       ORDER BY t.name`
    ).bind(...ids).all<{ bookmark_id: string; name: string }>();
    for (const row of rows.results || []) {
      output.get(row.bookmark_id)?.push(row.name);
    }
  }
  return output;
}

async function setFeedTags(env: Env, feedId: string, names: string[]): Promise<void> {
  await setRelationTags(env, "feed_tags", "feed_id", feedId, names, "replace");
}

async function setRelationTags(
  env: Env,
  table: "bookmark_tags" | "feed_tags",
  ownerColumn: "bookmark_id" | "feed_id",
  ownerId: string,
  names: string[],
  mode: "replace" | "merge"
): Promise<void> {
  const tagRows: Array<{ id: string; name: string }> = [];
  for (const name of uniqueTagNames(names)) tagRows.push(await ensureTag(env, name));

  const statements: D1PreparedStatement[] = [];
  if (mode === "replace") statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`).bind(ownerId));
  statements.push(...tagRows.map((tag) =>
    env.DB.prepare(`INSERT OR IGNORE INTO ${table} (${ownerColumn}, tag_id) VALUES (?, ?)`).bind(ownerId, tag.id)
  ));
  if (statements.length > 0) await env.DB.batch(statements);
}

async function getFeedTags(env: Env, feedId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT t.name FROM tags t JOIN feed_tags ft ON ft.tag_id = t.id WHERE ft.feed_id = ? ORDER BY t.name"
  ).bind(feedId).all<{ name: string }>();
  return (rows.results || []).map((row) => row.name);
}

async function getFeedTagsMap(env: Env, feedIds: string[]): Promise<Map<string, string[]>> {
  const output = new Map<string, string[]>();
  for (const id of feedIds) output.set(id, []);
  for (const ids of chunks(feedIds, 90)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT ft.feed_id, t.name
       FROM feed_tags ft
       JOIN tags t ON t.id = ft.tag_id
       WHERE ft.feed_id IN (${placeholders})
       ORDER BY t.name`
    ).bind(...ids).all<{ feed_id: string; name: string }>();
    for (const row of rows.results || []) {
      output.get(row.feed_id)?.push(row.name);
    }
  }
  return output;
}

async function getExistingFeedIds(env: Env, feedIds: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const ids of chunks(feedIds, 90)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await env.DB.prepare(`SELECT id FROM feeds WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string }>();
    output.push(...(rows.results || []).map((row) => row.id));
  }
  return output;
}

async function getRecentFeedItemsMap(env: Env, feedIds: string[], limitPerFeed: number): Promise<Map<string, FeedItem[]>> {
  const output = new Map<string, FeedItem[]>();
  for (const id of feedIds) output.set(id, []);
  for (const ids of chunks(feedIds, 90)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, feed_id, guid, url, canonical_url, title, author, published_at, discovered_at, summary, raw_hash
       FROM (
         SELECT fi.*, ROW_NUMBER() OVER (
           PARTITION BY feed_id
           ORDER BY COALESCE(published_at, discovered_at) DESC
         ) AS row_number
         FROM feed_items fi
         WHERE feed_id IN (${placeholders})
       )
       WHERE row_number <= ?`
    ).bind(...ids, limitPerFeed).all<FeedItem>();
    for (const item of rows.results || []) {
      output.get(item.feed_id)?.push(item);
    }
  }
  for (const items of output.values()) {
    items.sort((left, right) => (right.published_at || right.discovered_at).localeCompare(left.published_at || left.discovered_at));
  }
  return output;
}

export const riverQueryFeedBatchSize = 90;

export function savedFeedItemLookupQuery(feedCount: number): string {
  const placeholders = Array.from({ length: feedCount }, () => "?").join(", ");
  return `WITH selected_items AS (
      SELECT id, url
      FROM feed_items
      WHERE feed_id IN (${placeholders})
    )
    SELECT selected_items.id AS feed_item_id,
           selected_items.url AS feed_item_url,
           COALESCE(source_bookmark.id, url_bookmark.id) AS bookmark_id
    FROM selected_items
    LEFT JOIN bookmarks source_bookmark
      ON source_bookmark.source_feed_item_id = selected_items.id
     AND source_bookmark.status != 'deleted'
    LEFT JOIN bookmarks url_bookmark
      ON url_bookmark.url = selected_items.url
     AND url_bookmark.status != 'deleted'
    WHERE source_bookmark.id IS NOT NULL OR url_bookmark.id IS NOT NULL`;
}

async function getSavedFeedItemIds(env: Env, feedIds: string[]): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  for (const ids of chunks(feedIds, riverQueryFeedBatchSize)) {
    const rows = await env.DB.prepare(savedFeedItemLookupQuery(ids.length))
      .bind(...ids)
      .all<{ feed_item_id: string; feed_item_url: string; bookmark_id: string }>();
    for (const row of rows.results || []) {
      output.set(row.feed_item_id, row.bookmark_id);
      output.set(row.feed_item_url, row.bookmark_id);
    }
  }

  return output;
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function uniqueTagNames(names: string[]): string[] {
  return Array.from(new Set(names.map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((id) => typeof id === "string" && id.trim() ? [id.trim()] : [])));
}

function collectOutlines(value: unknown): Array<{ title?: string; feedUrl?: string }> {
  const found: Array<{ title?: string; feedUrl?: string }> = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node["@_xmlUrl"]) found.push({ title: node["@_title"] || node["@_text"], feedUrl: node["@_xmlUrl"] });
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(value);
  return found;
}

function normalizeFeedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return normalizePublicHttpUrl(value.trim());
  } catch {
    return null;
  }
}

function importFeedTitle(value: unknown, feedUrl: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return domainOf(feedUrl) || feedUrl;
}

function normalizeImportBookmark(input: ImportBookmarkInput): (Partial<Bookmark> & { url: string }) | null {
  if (typeof input.url !== "string" || !input.url.trim()) return null;
  try {
    const url = absolutize(input.url.trim());
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (input.canonical_url) normalizeBookmarkUrl(input.canonical_url);
    return {
      url,
      canonical_url: input.canonical_url || null,
      title: stringOrNull(input.title),
      description: stringOrNull(input.description),
      status: input.status === "archived" ? "archived" : "bucket",
      source: "import",
      notes: stringOrNull(input.notes),
      saved_at: validIsoDate(input.saved_at) || undefined,
      archived_at: input.status === "archived" ? stringOrNull(input.archived_at) : null
    };
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function faviconForUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL("/favicon.ico", value).toString();
  } catch {
    return null;
  }
}

function arrayify<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstLink(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const links = arrayify(value);
  const alternate = links.find((link: any) => !link["@_rel"] || link["@_rel"] === "alternate") || links[0];
  return typeof alternate === "string" ? alternate : alternate?.["@_href"] || alternate?.["#text"] || "";
}

function textOf(value: any): string {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return decodeXmlText(String(value));
  return decodeXmlText(value["#text"] || "");
}

function decodeXmlText(value: string): string {
  return normalizeText(value);
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  let output = String(value);
  for (let pass = 0; pass < 4; pass++) {
    const decoded = decodeHtmlEntities(output);
    if (decoded === output) break;
    output = decoded;
  }
  return output;
}

function normalizeOptionalText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeParsedFeedItem(item: ParsedFeed["items"][number]): ParsedFeed["items"][number] {
  return {
    ...item,
    guid: normalizeOptionalText(item.guid),
    title: normalizeText(item.title || item.url),
    author: normalizeOptionalText(item.author),
    summary: normalizeOptionalText(item.summary)
  };
}

function normalizeFeedRecord(feed: Feed): void {
  feed.title = normalizeText(feed.title);
  feed.description = normalizeOptionalText(feed.description) || null;
}

function normalizeFeedItemRecord(item: FeedItem): void {
  item.guid = normalizeOptionalText(item.guid) || null;
  item.title = normalizeText(item.title);
  item.author = normalizeOptionalText(item.author) || null;
  item.summary = normalizeOptionalText(item.summary) || null;
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function normalizeDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseHtmlAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of input.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = match[3] || match[4] || match[5] || "";
  }
  return attrs;
}

async function safeFetch(inputUrl: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
  const url = normalizePublicHttpUrl(inputUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), outboundFetchTimeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (isRedirectStatus(response.status)) {
      if (redirects >= outboundFetchMaxRedirects) throw new Error("Too many redirects");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect missing location");
      return safeFetch(normalizePublicHttpUrl(location, url), init, redirects + 1);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response: Response, maxBytes = outboundPageMaxBytes): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("Response too large");
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchPageMetadata(inputUrl: string): Promise<{ finalUrl: string; title: string | null }> {
  let normalizedUrl = inputUrl;
  try {
    normalizedUrl = normalizePublicHttpUrl(inputUrl);
    const response = await safeFetch(normalizedUrl, {
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Riverbucket/0.1"
      }
    });
    const finalUrl = normalizePublicHttpUrl(response.url || normalizedUrl);
    if (!response.ok) return { finalUrl, title: null };
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.includes("html") && !contentType.includes("text")) return { finalUrl, title: null };
    const text = await readLimitedText(response);
    const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return { finalUrl, title: cleanHtmlText(title) };
  } catch {
    return { finalUrl: normalizedUrl, title: null };
  }
}

async function fetchBookmarkMetadata(inputUrl: string): Promise<{ finalUrl: string; title: string | null }> {
  const normalizedUrl = normalizePublicHttpUrl(inputUrl);
  if (youtubeVideoId(normalizedUrl)) return { finalUrl: normalizedUrl, title: null };
  const metadata = await fetchPageMetadata(normalizedUrl);
  if (isGoogleSorryUrl(metadata.finalUrl)) return { finalUrl: normalizedUrl, title: null };
  return metadata;
}

function isGoogleSorryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "google.com" && url.pathname.startsWith("/sorry/");
  } catch {
    return false;
  }
}

function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(absolutize(value));
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") return validYouTubeId(url.pathname.split("/").filter(Boolean)[0]);
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (url.pathname === "/watch") return validYouTubeId(url.searchParams.get("v") || "");
    const [prefix, id] = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live", "v"].includes(prefix || "")) return validYouTubeId(id);
    return null;
  } catch {
    return null;
  }
}

function validYouTubeId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

function cleanHtmlText(value: string | undefined): string | null {
  const cleaned = normalizeText((value || "").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return validCodePoint(point) ? String.fromCodePoint(point) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const point = Number.parseInt(code, 16);
      return validCodePoint(point) ? String.fromCodePoint(point) : _match;
    })
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rdquo;/gi, "\u201d")
    .replace(/&ldquo;/gi, "\u201c")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&hellip;/gi, "\u2026")
    .replace(/&nbsp;/gi, " ");
}

function boolInt(value: unknown): number {
  return value === true || value === 1 ? 1 : 0;
}

function absolutize(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) throw new Error("URL must use http or https");
  return `https://${trimmed}`;
}

function normalizeBookmarkUrl(value: string): string {
  const url = new URL(absolutize(value));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http or https");
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/" && url.pathname.endsWith("/") && !url.search) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || ["fbclid", "gclid", "dclid", "gbraid", "wbraid", "mc_cid", "mc_eid"].includes(lower);
}

function domainOf(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

function requireSameOriginForMutation(request: Request): true | Response {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) return true;
  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") return json({ error: "Cross-site request rejected" }, 403);
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin !== new URL(request.url).origin) return json({ error: "Cross-site request rejected" }, 403);
  return true;
}

async function publishAppInvalidation(
  env: Env,
  scopes: AppSyncScope[],
  request?: Request
): Promise<void> {
  const normalized = normalizeAppSyncScopes(scopes);
  if (normalized.length === 0) return;
  const sourceClientId = request?.headers.get("x-riverbucket-client-id") || undefined;
  try {
    await env.APP_SYNC.getByName("app").fetch("https://app-sync/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "app.invalidate",
        scopes: normalized,
        ...(validClientId(sourceClientId || "") ? { sourceClientId } : {})
      })
    });
  } catch (error) {
    console.error("App sync publish failed", error);
  }
}

function normalizeAppSyncScopes(scopes: unknown[]): AppSyncScope[] {
  const allowed = new Set<AppSyncScope>(["river", "bucket", "feeds", "feedTags", "tags", "extensionTokens"]);
  return Array.from(new Set(scopes.filter((scope): scope is AppSyncScope =>
    typeof scope === "string" && allowed.has(scope as AppSyncScope)
  )));
}

function validClientId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function sessionSecret(request: Request, env: Env): string | null {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  return allowDevAuthDefaults(request) ? devSessionSecret : null;
}

function allowDevAuthDefaults(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function sessionCookieHeader(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${sessionCookie}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hex(digest);
}

async function hmac(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return btoaUrl(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifyAppPassword(password: string, storedHash: string | undefined, allowDefault: boolean): Promise<boolean> {
  if (!storedHash) return allowDefault && timingSafeEqual(password, "riverbucket");

  const parsed = parsePasswordHash(storedHash);
  if (!parsed) return false;
  try {
    const actualHash = await derivePasswordHash(password, parsed.salt, parsed.iterations);
    return timingSafeEqual(bytesToBase64Url(actualHash), parsed.hash);
  } catch (error) {
    console.error("Failed to verify app password hash", error);
    return false;
  }
}

function parsePasswordHash(storedHash: string): { iterations: number; salt: Uint8Array; hash: string } | null {
  const parts = storedHash.trim().split("$");
  if (parts.length !== 4) return null;
  const [algorithm, iterationsText, saltText, hash] = parts;
  const iterations = Number(iterationsText);
  if (
    algorithm !== passwordHashAlgorithm ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > passwordHashIterations
  ) {
    return null;
  }
  if (!saltText || !hash) return null;
  try {
    return { iterations, salt: base64UrlToBytes(saltText), hash };
  } catch {
    return null;
  }
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations = passwordHashIterations): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    passwordHashBytes * 8
  );
  return new Uint8Array(bits);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function btoaUrl(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function atobUrl(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoaUrl(String.fromCharCode(...bytes));
}

function base64UrlToBytes(input: string): Uint8Array {
  const decoded = atobUrl(input);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char] || char);
}
