import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  ArchiveRestore,
  Check,
  History,
  KeyRound,
  PaintBucket,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-serif/400.css";
import "@fontsource/ibm-plex-serif/400-italic.css";
import "@fontsource/ibm-plex-serif/500.css";
import "@fontsource/ibm-plex-serif/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/fraunces";
import "@fontsource/zilla-slab/600.css";
import "./styles.css";

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
  last_fetched_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  refresh_claimed_at?: string | null;
  refresh_claim_id?: string | null;
  tags?: string[];
};

type FeedItem = {
  id: string;
  feed_id: string;
  url: string;
  title: string;
  published_at: string | null;
  discovered_at: string;
  saved_id?: string | null;
};

type RiverGroup = { feed: Feed; items: FeedItem[] };

type Bookmark = {
  id: string;
  url: string;
  title: string | null;
  domain: string | null;
  status: string;
  saved_at: string;
  archived_at: string | null;
  notes: string | null;
  tags?: string[];
};

type Tag = { id: string; name: string };

type FeedTag = Tag & { feed_count: number };

type TokenRow = {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type OpmlFeed = {
  feedUrl: string;
  title?: string;
};

type OpmlImportResult = {
  imported: number;
  skipped: number;
  ignored: number;
  feedIds: string[];
};

type BookmarkImportInput = {
  url: string;
  title?: string;
  description?: string;
  canonical_url?: string;
  status?: "bucket" | "archived";
  archived_at?: string | null;
  saved_at?: string;
  notes?: string;
  tags?: string[];
};

type BookmarkImportResult = {
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

type FullJsonImportResult = {
  feeds: ImportTableSummary;
  feed_items: ImportTableSummary;
  bookmarks: ImportTableSummary;
  tags: ImportTableSummary;
  bookmark_tags: ImportTableSummary;
  feed_tags: ImportTableSummary;
};

type BookmarkSaveResponse = {
  bookmark: Bookmark;
  created: boolean;
  duplicate: boolean;
};

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
  groups: RiverGroup[];
  tags: FeedTag[];
};

type StartupRiverResponse = {
  authenticated: true;
  river: RiverResponse;
};

type BucketResponse = {
  bookmarks: Bookmark[];
  tags: Tag[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  nextCursor?: string | null;
};

const tabs = ["River", "Bucket", "Feeds", "Import/Export", "Settings"] as const;
const primaryTabs = ["River", "Bucket"] as const;
const secondaryTabs = ["Feeds", "Import/Export", "Settings"] as const;
type Tab = (typeof tabs)[number];
type RiverSort = "newest" | "title";
type BucketStatus = "bucket" | "archived";
type BucketRowAction = "busy" | "exiting";
type Route =
  | { view: "river"; tag: string; sort: RiverSort }
  | { view: "bucket"; status: BucketStatus; tag: string; query: string; page: number }
  | { view: "feeds" }
  | { view: "import-export" }
  | { view: "settings" };

const riverCacheMs = 5 * 60 * 1000;
const bucketCacheMs = 10 * 60 * 1000;
const bucketPageSize = 50;
const feedsCacheMs = 10 * 60 * 1000;

const TAGLINES = [
  "Watchin' feeds like it's '07.",
  "Anonymous Proxy's Finest News Source.",
  "Read it now, later, or never.",
  "All the river that's fit to bucket.",
  "Sipping from the firehose.",
  "Not an attempt to compete with Pinboard.",
  "Where blog posts go to die.",
  "Where articles go to die.",
  "Where thinkpieces go to die.",
  "Letting the takes float on by.",
  "You'll clear that backlog one of these days, don't worry.",
  "Limited doomscrolling.",
  "Become your own algorithm.",
  "Sometimes, newer isn't better.",
  "Vibe-coded with love.",
  "A firehose of minutiae.",
  "Readin' on the river.",
  "Mostly functional.",
  "The only algorithm we need is the inevitable passage of time.",
  "Not that type of bucket list."
];

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const route = useHashRoute();
  const tab = routeTab(route);
  const appToneClass = appToneForTab(tab);
  const tagline = React.useMemo(() => TAGLINES[Math.floor(Math.random() * TAGLINES.length)], []);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      const initialRoute = parseHashRoute(window.location.hash);
      if (initialRoute.view === "river") {
        const path = riverPath(initialRoute);
        try {
          const data = await api<StartupRiverResponse>(startupRiverPath(initialRoute));
          if (cancelled) return;
          writeApiCache(path, data.river, ["river", "feedTags"]);
          warmRiverCaches(initialRoute, data.river);
          setAuthed(true);
        } catch (err) {
          if (cancelled) return;
          if (isUnauthorizedApiError(err)) {
            setAuthed(false);
            return;
          }
          console.error(err);
          setAuthed(true);
        }
        return;
      }

      try {
        await api<{ authenticated: boolean }>("/api/me");
        if (!cancelled) setAuthed(true);
      } catch (err) {
        if (cancelled) return;
        if (!isUnauthorizedApiError(err)) console.error(err);
        setAuthed(false);
      }
    }

    loadSession().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  if (authed === null) {
    return (
      <main className="center">
        <BrandLoading text="Loading Riverbucket..." />
      </main>
    );
  }
  if (!authed) return <Login onLogin={() => setAuthed(true)} tagline={tagline} />;

  return (
    <div className={`app ${appToneClass}`}>
      <header className="topbar">
        <div className="brandBlock">
          <img className="brandLogo" src="/brand/riverbucket-logo.png" alt="" />
          <div>
            <h1>
              <span className="river">River</span>
              <span className="bucket">bucket</span>
            </h1>
            <p className="tagline"><i>{tagline}</i></p>
          </div>
        </div>
        <nav className="topnav" aria-label="Primary">
          <div className="navPrimary">
            {primaryTabs.map((item) => (
              <RouteTabLink key={item} route={routeForTab(item)} className={`${tab === item ? "active " : ""}navPrimary${item}`}>
                {item}
              </RouteTabLink>
            ))}
          </div>
          <div className="navUtility">
            {secondaryTabs.map((item, index) => (
              <React.Fragment key={item}>
                {index > 0 && <span className="sep" aria-hidden="true">·</span>}
                <RouteTabLink route={routeForTab(item)} className={tab === item ? "active" : ""}>
                  {item}
                </RouteTabLink>
              </React.Fragment>
            ))}
          </div>
        </nav>
      </header>
      {route.view === "river" && (
        <River
          route={route}
        />
      )}
      {route.view === "bucket" && <Bucket route={route} />}
      {tab === "Feeds" && <Feeds />}
      {tab === "Import/Export" && <ImportExport />}
      {tab === "Settings" && <Settings onLogout={() => setAuthed(false)} />}
    </div>
  );
}

function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const canonical = routeHash(parseHashRoute(window.location.hash));
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${canonical}`);
    }

    function onHashChange() {
      setRoute(parseHashRoute(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

function parseHashRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/river";
  const [pathPart, queryPart = ""] = raw.startsWith("/") ? raw.split("?") : `/${raw}`.split("?");
  const params = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter(Boolean).map(decodePathSegment);

  if (segments[0] === "bucket") {
    const status = segments[1] === "archived" ? "archived" : "bucket";
    return {
      view: "bucket",
      status,
      tag: params.get("tag") || "",
      query: params.get("q") || "",
      page: positiveInt(params.get("page")) || 1
    };
  }

  if (segments[0] === "feeds") return { view: "feeds" };
  if (segments[0] === "import-export") return { view: "import-export" };
  if (segments[0] === "settings") return { view: "settings" };

  const sort = params.get("sort") === "title" ? "title" : "newest";
  if (segments[0] === "river" && segments[1] === "untagged") return { view: "river", tag: "untagged", sort };
  if (segments[0] === "river" && segments[1] === "tag" && segments[2]) return { view: "river", tag: segments[2], sort };
  return { view: "river", tag: "all", sort };
}

function routeHash(route: Route): string {
  if (route.view === "feeds") return "#/feeds";
  if (route.view === "import-export") return "#/import-export";
  if (route.view === "settings") return "#/settings";

  if (route.view === "river") {
    const params = new URLSearchParams();
    if (route.sort !== "newest") params.set("sort", route.sort);
    const suffix = params.toString() ? `?${params}` : "";
    if (route.tag === "untagged") return `#/river/untagged${suffix}`;
    if (route.tag !== "all") return `#/river/tag/${encodeURIComponent(route.tag)}${suffix}`;
    return `#/river${suffix}`;
  }

  const params = new URLSearchParams();
  if (route.tag) params.set("tag", route.tag);
  if (route.query) params.set("q", route.query);
  if (route.page > 1) params.set("page", String(route.page));
  const suffix = params.toString() ? `?${params}` : "";
  return `#/bucket${route.status === "archived" ? "/archived" : ""}${suffix}`;
}

function riverPath(route: Extract<Route, { view: "river" }>): string {
  return `/api/river?${riverSearchParams(route)}`;
}

function startupRiverPath(route: Extract<Route, { view: "river" }>): string {
  return `/api/startup/river?${riverSearchParams(route)}`;
}

function riverSearchParams(route: Extract<Route, { view: "river" }>): URLSearchParams {
  const params = new URLSearchParams({ sort: route.sort });
  if (route.tag === "untagged") params.set("untagged", "1");
  else if (route.tag !== "all") params.set("tag", route.tag);
  return params;
}

function bucketPath(route: Extract<Route, { view: "bucket" }>): string {
  const params = new URLSearchParams();
  params.set("status", route.status);
  params.set("limit", String(bucketPageSize));
  params.set("page", String(route.page));
  if (route.query) params.set("q", route.query);
  if (route.tag) params.set("tag", route.tag);
  return `/api/bookmarks?${params}`;
}

function routeTab(route: Route): Tab {
  if (route.view === "river") return "River";
  if (route.view === "bucket") return "Bucket";
  if (route.view === "feeds") return "Feeds";
  if (route.view === "import-export") return "Import/Export";
  return "Settings";
}

function routeForTab(tab: Tab): Route {
  if (tab === "Bucket") return { view: "bucket", status: "bucket", tag: "", query: "", page: 1 };
  if (tab === "Feeds") return { view: "feeds" };
  if (tab === "Import/Export") return { view: "import-export" };
  if (tab === "Settings") return { view: "settings" };
  return { view: "river", tag: "all", sort: "newest" };
}

function appToneForTab(tab: Tab): string {
  if (tab === "River") return "appRiver";
  if (tab === "Bucket") return "appBucket";
  if (tab === "Feeds") return "appFeeds";
  if (tab === "Import/Export") return "appImportExport";
  if (tab === "Settings") return "appSettings";
  return "";
}

function navigateToRoute(route: Route) {
  const nextHash = routeHash(route);
  if (window.location.hash === nextHash) return;
  window.location.hash = nextHash;
}

function RouteTabLink({ children, className, route }: { children: React.ReactNode; className: string; route: Route }) {
  function followRoute(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateToRoute(route);
  }

  return (
    <a className={className} href={routeHash(route)} onClick={followRoute}>
      {children}
    </a>
  );
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positiveInt(value: string | null): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function Login({ onLogin, tagline }: { onLogin: () => void; tagline: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/login", { method: "POST", body: { password } });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="brandBlock loginBrand">
          <img className="brandLogo" src="/brand/riverbucket-logo.png" alt="" />
          <div>
            <h1>
              <span className="river">River</span>
              <span className="bucket">bucket</span>
            </h1>
            <p className="tagline"><i>{tagline}</i></p>
          </div>
        </div>
        <label>
          App password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}

function River({ route }: { route: Extract<Route, { view: "river" }> }) {
  const initialCache = readApiCache<RiverResponse>(riverPath(route), riverCacheMs);
  const initialRiver = initialCache?.data || null;
  const [groups, setGroups] = useState<RiverGroup[]>(() => initialRiver?.groups || []);
  const [feedTags, setFeedTags] = useState<FeedTag[]>(() => initialRiver?.tags || []);
  const tag = route.tag;
  const sort = route.sort;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(() => !initialRiver);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  const [liveStatus, setLiveStatus] = useState(() => initialCache && !initialCache.fresh ? "Updating river..." : "");
  const [message, setMessage] = useState("");
  const [refreshingAll, setRefreshingAll] = useState(false);
  const loadSeq = useRef(0);
  const refreshPollSeq = useRef(0);

  function applyRiver(data: RiverResponse) {
    setGroups(data.groups);
    setFeedTags(data.tags);
  }

  async function load(force = false): Promise<RiverResponse | null> {
    setError("");
    const seq = ++loadSeq.current;
    const path = riverPath(route);
    const cached = force ? null : readApiCache<RiverResponse>(path, riverCacheMs);
    const hasVisibleRiver = groups.length > 0;
    if (cached) {
      applyRiver(cached.data);
      setLoading(false);
      if (cached.fresh) {
        setUpdating(false);
        setLiveStatus("");
        return cached.data;
      }
      setUpdating(true);
      setLiveStatus("Updating river...");
    } else if (hasVisibleRiver) {
      setUpdating(true);
      setLiveStatus("Updating river...");
    } else {
      setLoading(true);
      setLiveStatus("Loading river...");
    }
    try {
      const riverData = await api<RiverResponse>(path);
      if (seq !== loadSeq.current) return null;
      writeApiCache(path, riverData, ["river", "feedTags"]);
      warmRiverCaches(route, riverData);
      applyRiver(riverData);
      setError("");
      setLiveStatus("River updated.");
      return riverData;
    } catch (err) {
      if (seq !== loadSeq.current) return null;
      const text = err instanceof Error ? err.message : "Failed to load river.";
      if (!cached && !hasVisibleRiver) {
        setError(text);
        setLiveStatus(text);
      } else {
        console.error(err);
        setLiveStatus("River update failed.");
      }
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setUpdating(false);
      }
    }
    return null;
  }

  useEffect(() => {
    load().catch(console.error);
  }, [sort, tag]);

  async function refreshAll() {
    if (refreshingAll) return;
    const pollSeq = ++refreshPollSeq.current;
    setRefreshingAll(true);
    setMessage("Loading feeds to refresh...");
    try {
      const data = await api<{ feeds: Feed[] }>("/api/feeds");
      const feedIds = data.feeds.map((feed) => feed.id);
      if (feedIds.length === 0) {
        setMessage("No feeds to refresh.");
        return;
      }
      setMessage(`Queueing ${feedIds.length} feeds...`);
      const queued = await queueFeedRefresh(feedIds);
      invalidateCacheTags(["river", "feeds", "feedTags", "bucket"]);
      if (queued.queued === 0) {
        setMessage(queued.total > 0 ? "Feeds are already refreshing." : "No feeds to refresh.");
        return;
      }
      setMessage(`Refresh queued for ${queued.queued}/${queued.total} feeds. Updating river...`);
      void pollQueuedRiverRefresh(queued, pollSeq).catch(console.error);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Refresh all failed.");
    } finally {
      setRefreshingAll(false);
    }
  }

  async function pollQueuedRiverRefresh(queued: RefreshQueueResult, pollSeq: number): Promise<void> {
    const completedQuickly = await pollRiverRefresh(8, pollSeq);
    if (pollSeq !== refreshPollSeq.current) return;
    if (completedQuickly) {
      setMessage("");
      return;
    }
    setMessage(`Refresh queued for ${queued.queued}/${queued.total} feeds. Still updating in background.`);
    const completed = await pollRiverRefresh(60, pollSeq, 10000);
    if (pollSeq === refreshPollSeq.current && completed) setMessage("");
  }

  async function pollRiverRefresh(attempts: number, pollSeq: number, intervalMs = 2500): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(attempt === 0 ? 1000 : intervalMs);
      if (pollSeq !== refreshPollSeq.current) return false;
      invalidateCacheTags(["river", "feeds", "feedTags", "bucket"]);
      const [riverData, feedsData] = await Promise.all([
        load(true),
        api<{ feeds: Feed[] }>("/api/feeds")
      ]);
      if (riverData && !hasActiveRefreshClaims(riverData) && !hasActiveFeedRefreshClaims(feedsData.feeds)) return true;
    }
    return false;
  }

  return (
    <main className="page">
      <section className="toolbar">
        <div className="segments tagTabs">
          <button className={tag === "all" ? "active" : ""} onClick={() => navigateToRoute({ view: "river", tag: "all", sort })}>All</button>
          {feedTags.map((item) => (
            <button key={item.id} className={tag === item.name ? "active" : ""} onClick={() => navigateToRoute({ view: "river", tag: item.name, sort })}>
              {item.name} <span>{item.feed_count}</span>
            </button>
          ))}
          <button className={tag === "untagged" ? "active" : ""} onClick={() => navigateToRoute({ view: "river", tag: "untagged", sort })}>Untagged</button>
        </div>
      </section>
      <section className="toolbar">
        <div className="segments">
          {[
            ["newest", "Newest"],
            ["title", "A-Z"]
          ].map(([value, label]) => (
            <button key={value} className={sort === value ? "active" : ""} onClick={() => navigateToRoute({ view: "river", tag, sort: value as RiverSort })}>
              {label}
            </button>
          ))}
        </div>
        <div className="actions">
          <button className="iconText" onClick={refreshAll} disabled={refreshingAll}><RefreshCw size={16} /> Refresh all</button>
        </div>
      </section>
      <p className="srOnly" aria-live="polite">{message || liveStatus}</p>
      {message && <p className="muted">{message}</p>}
      {!message && updating && <p className="muted">Updating river...</p>}
      {error && <p className="error">{error}</p>}
      {loading && groups.length === 0 && <BrandLoading text="Loading river..." />}
      {!loading && !error && groups.length === 0 && <Empty text="No feeds yet. Add one on the Feeds tab." />}
      <div className="feedList riverList" aria-busy={loading || updating || refreshingAll}>
        {groups.map(({ feed, items }) => {
          const isExpanded = Boolean(expanded[feed.id]);
          const visible = isExpanded ? items.slice(0, 10) : items.slice(0, 5);
          const feedHref = safeHref(feed.site_url || feed.feed_url);
          return (
            <section className="riverFeed" key={feed.id}>
              <div className="riverFeedMain">
                <header className="riverFeedHeader">
                  <RiverIcon feed={feed} />
                  {feedHref ? (
                    <a className="riverFeedTitle" href={feedHref} target="_blank" rel="noreferrer">{feed.title}</a>
                  ) : (
                    <span className="riverFeedTitle">{feed.title}</span>
                  )}
                  {items[0] && <RelativeTime className="ageBadge" value={items[0].published_at || items[0].discovered_at} />}
                  <span className="riverDomain">{domain(feed.site_url || feed.feed_url)}</span>
                  <Status feed={feed} compact />
                </header>
                <div className="riverItemLine">
                  <button
                    className="riverExpand"
                    title={isExpanded ? "Collapse feed items" : "Expand feed items"}
                    aria-label={isExpanded ? "Collapse feed items" : "Expand feed items"}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded((state) => ({ ...state, [feed.id]: !state[feed.id] }))}
                    disabled={items.length === 0}
                  >
                    {">"}
                  </button>
                  <div className={`riverItems ${isExpanded ? "expanded" : ""}`}>
                    {visible.length > 0 ? (
                      visible.map((item, index) => (
                        <React.Fragment key={item.id}>
                          {!isExpanded && index > 0 && <span className="riverSeparator">/</span>}
                          <RiverInlineItem item={item} />
                        </React.Fragment>
                      ))
                    ) : (
                      <span className="riverEmpty">No items yet. Run Refresh all to fetch this feed.</span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

function BrandLoading({ text }: { text: string }) {
  return (
    <div className="brandLoading" role="status" aria-live="polite">
      <img className="brandLoadingLogo" src="/brand/riverbucket-logo.png" alt="" />
      <p>{text}</p>
    </div>
  );
}

function RiverIcon({ feed }: { feed: Feed }) {
  const [showImage, setShowImage] = useState(Boolean(feed.favicon_url));
  return (
    <div className="riverIcon" aria-hidden="true">
      {showImage && feed.favicon_url ? (
        <img src={feed.favicon_url} alt="" loading="lazy" onError={() => setShowImage(false)} />
      ) : (
        feed.title.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

function RiverInlineItem({ item }: { item: FeedItem }) {
  const [saved, setSaved] = useState(Boolean(item.saved_id));
  const href = safeHref(item.url);
  async function save() {
    const result = await api<{ bookmark: Bookmark }>(`/api/feed-items/${item.id}/save`, { method: "POST" });
    setSaved(true);
    markCachedRiverItemSaved(item.id, item.url, result.bookmark.id);
    invalidateCacheTags(["bucket"]);
  }
  return (
    <span className="riverItem">
      {href ? (
        <a className="riverItemTitle" href={href} target="_blank" rel="noreferrer">{item.title}</a>
      ) : (
        <span className="riverItemTitle">{item.title}</span>
      )}
      <RelativeTime className="riverItemAge" value={item.published_at || item.discovered_at} />
      <button className="riverSave" title={saved ? "Saved" : "Save to bucket"} aria-label={saved ? "Saved" : "Save to bucket"} onClick={save} disabled={saved}>
        {saved ? <Check size={13} /> : <PaintBucket size={13} />}
      </button>
    </span>
  );
}

function Bucket({ route }: { route: Extract<Route, { view: "bucket" }> }) {
  const initialCache = readApiCache<BucketResponse>(bucketPath(route), bucketCacheMs);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => initialCache?.data.bookmarks || []);
  const [tags, setTags] = useState<Tag[]>(() => initialCache?.data.tags || []);
  const [pagination, setPagination] = useState(() => ({
    page: initialCache?.data.page || route.page,
    pageSize: initialCache?.data.pageSize || bucketPageSize,
    total: initialCache?.data.total || 0,
    totalPages: initialCache?.data.totalPages || 1
  }));
  const [loading, setLoading] = useState(() => !initialCache);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [rowActions, setRowActions] = useState<Record<string, BucketRowAction>>({});
  const [enteringRows, setEnteringRows] = useState<Record<string, true>>({});
  const rowTimers = useRef<number[]>([]);
  const status = route.status;
  const tag = route.tag;
  const page = route.page;
  const [query, setQuery] = useState(route.query);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const loadSeq = useRef(0);

  useEffect(() => {
    return () => {
      for (const timer of rowTimers.current) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    setQuery(route.query);
  }, [route.query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query !== route.query) applyBucketFilters({ query, page: 1 });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, route.query, status, tag]);

  function applyBucket(data: BucketResponse) {
    setBookmarks(data.bookmarks);
    setTags(data.tags);
    setPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages
    });
  }

  async function load(force = false, options: { background?: boolean } = {}) {
    setError("");
    const seq = ++loadSeq.current;
    const path = bucketPath(route);
    const cached = force ? null : readApiCache<BucketResponse>(path, bucketCacheMs);
    if (cached) {
      applyBucket(cached.data);
      setLoading(false);
      if (cached.fresh) return;
    } else if (!options.background) {
      setLoading(true);
    }
    try {
      const bookmarkData = await api<BucketResponse>(path);
      if (seq !== loadSeq.current) return;
      if (bookmarkData.page > bookmarkData.totalPages && bookmarkData.totalPages > 0) {
        navigateToRoute({ ...route, page: bookmarkData.totalPages });
        return;
      }
      writeApiCache(path, bookmarkData, ["bucket", "tags"]);
      applyBucket(bookmarkData);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (cached) console.error(err);
      else setError(err instanceof Error ? err.message : "Failed to load bucket.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, [status, tag, route.query, page]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      load(true, { background: true }).catch(console.error);
    }, 60 * 1000);
    return () => window.clearInterval(interval);
  }, [status, tag, route.query, page]);

  function applyBucketFilters(next: Partial<Pick<Extract<Route, { view: "bucket" }>, "status" | "tag" | "query" | "page">>) {
    navigateToRoute({
      view: "bucket",
      status,
      tag,
      query,
      page: 1,
      ...next
    });
  }

  async function saveManual(event: FormEvent) {
    event.preventDefault();
    const result = await api<BookmarkSaveResponse>("/api/bookmarks", { method: "POST", body: { url, title } });
    invalidateCacheTags(["bucket", "tags"]);
    setUrl("");
    setTitle("");
    if (page !== 1) {
      navigateToRoute({ ...route, page: 1 });
      return;
    }
    if (status === "bucket" && !tag && !route.query) {
      prependBookmark(result.bookmark, result.created);
      scheduleReconcile();
      return;
    }
    await load(true);
  }

  async function refreshBucket() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load(true, { background: true });
    } finally {
      setRefreshing(false);
    }
  }

  function goToPage(nextPage: number) {
    const boundedPage = Math.max(1, Math.min(nextPage, pagination.totalPages));
    if (boundedPage === page) return;
    navigateToRoute({ ...route, page: boundedPage });
  }

  function scheduleReconcile() {
    load(true, { background: true }).catch(console.error);
  }

  function scheduleRowTimer(callback: () => void, delay: number) {
    const timer = window.setTimeout(() => {
      rowTimers.current = rowTimers.current.filter((item) => item !== timer);
      callback();
    }, delay);
    rowTimers.current.push(timer);
  }

  function setRowAction(id: string, action: BucketRowAction | null) {
    setRowActions((current) => {
      const next = { ...current };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }

  function updatePaginationTotal(delta: number) {
    setPagination((current) => {
      const total = Math.max(0, current.total + delta);
      return {
        ...current,
        total,
        totalPages: Math.max(1, Math.ceil(total / current.pageSize))
      };
    });
  }

  function removeBookmarkLocally(id: string) {
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
    updatePaginationTotal(-1);
  }

  function updateBookmarkTags(id: string, nextTags: string[]): boolean {
    if (tag && !nextTags.includes(tag)) {
      runLocalExit(id, () => updatePaginationTotal(-1));
      return true;
    }
    setBookmarks((current) => current.map((bookmark) => bookmark.id === id ? { ...bookmark, tags: nextTags } : bookmark));
    return false;
  }

  function runLocalExit(id: string, afterExit: () => void) {
    setRowAction(id, "exiting");
    scheduleRowTimer(() => {
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
      setRowAction(id, null);
      afterExit();
      scheduleReconcile();
    }, 240);
  }

  function prependBookmark(bookmark: Bookmark, created: boolean) {
    const added = created && !bookmarks.some((item) => item.id === bookmark.id);
    setBookmarks((current) => {
      return [bookmark, ...current.filter((item) => item.id !== bookmark.id)].slice(0, pagination.pageSize);
    });
    if (added) updatePaginationTotal(1);
    setEnteringRows((current) => ({ ...current, [bookmark.id]: true }));
    scheduleRowTimer(() => {
      setEnteringRows((current) => {
        const next = { ...current };
        delete next[bookmark.id];
        return next;
      });
    }, 320);
  }

  async function moveBookmark(bookmark: Bookmark, endpoint: "archive" | "restore" | "delete") {
    if (rowActions[bookmark.id]) return;
    setError("");
    setRowAction(bookmark.id, "exiting");
    try {
      const path = endpoint === "delete" ? `/api/bookmarks/${bookmark.id}` : `/api/bookmarks/${bookmark.id}/${endpoint}`;
      await api(path, { method: endpoint === "delete" ? "DELETE" : "POST" });
      invalidateCacheTags(["bucket", "tags"]);
      scheduleRowTimer(() => {
        removeBookmarkLocally(bookmark.id);
        setRowAction(bookmark.id, null);
        scheduleReconcile();
      }, 240);
    } catch (err) {
      setRowAction(bookmark.id, null);
      setError(err instanceof Error ? err.message : "Bucket action failed.");
    }
  }

  async function saveBookmarkTags(bookmark: Bookmark, nextTags: string[]) {
    if (rowActions[bookmark.id]) return;
    setError("");
    setRowAction(bookmark.id, "busy");
    try {
      const result = await api<{ tags: string[] }>(`/api/bookmarks/${bookmark.id}/tags`, {
        method: "POST",
        body: { tags: nextTags }
      });
      invalidateCacheTags(["bucket", "tags"]);
      const exiting = updateBookmarkTags(bookmark.id, result.tags);
      if (!exiting) scheduleReconcile();
      return exiting;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tags.");
      throw err;
    } finally {
      setRowActions((current) => {
        if (current[bookmark.id] !== "busy") return current;
        const next = { ...current };
        delete next[bookmark.id];
        return next;
      });
    }
  }

  return (
    <main className="page">
      <form className="inlineForm" onSubmit={saveManual}>
        <input placeholder="https://example.com/article" value={url} onChange={(event) => setUrl(event.target.value)} />
        <input placeholder="Optional title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <button type="submit"><Plus size={16} /> Save</button>
      </form>
      <section className="toolbar">
        <div className="bucketFilters">
          <select value={tag} onChange={(event) => applyBucketFilters({ tag: event.target.value, page: 1 })}>
            <option value="">all tags</option>
            {tags.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
          </select>
          <div className="segments">
            {["bucket", "archived"].map((value) => (
              <button key={value} className={status === value ? "active" : ""} onClick={() => applyBucketFilters({ status: value as BucketStatus, page: 1 })}>{value}</button>
            ))}
          </div>
        </div>
        <label className="search"><Search size={16} /><input value={query} placeholder="Search title, domain, url" onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="iconText" onClick={refreshBucket} disabled={refreshing}>
          <RefreshCw size={16} /> {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </section>
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading bucket...</p>}
      {!loading && !error && bookmarks.length === 0 && <Empty text="No saved links match this view." />}
      <div className="bookmarkList">
        {bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            action={rowActions[bookmark.id] || null}
            entering={Boolean(enteringRows[bookmark.id])}
            onArchive={() => moveBookmark(bookmark, "archive")}
            onRestore={() => moveBookmark(bookmark, "restore")}
            onDelete={() => moveBookmark(bookmark, "delete")}
            onSaveTags={(nextTags) => saveBookmarkTags(bookmark, nextTags)}
          />
        ))}
      </div>
      {pagination.totalPages > 1 && (
        <PaginationControls
          page={page}
          totalPages={pagination.totalPages}
          loading={loading}
          onPage={goToPage}
        />
      )}
    </main>
  );
}

function PaginationControls({ page, totalPages, loading, onPage }: { page: number; totalPages: number; loading: boolean; onPage: (page: number) => void }) {
  const pages = paginationWindow(page, totalPages);
  return (
    <nav className="pagination" aria-label="Bucket pagination">
      <button onClick={() => onPage(page - 1)} disabled={loading || page <= 1}>Previous</button>
      <div className="pageNumbers">
        {pages.map((item, index) => item === "ellipsis" ? (
          <span key={`${item}-${index}`} className="pageEllipsis">...</span>
        ) : (
          <button key={item} className={item === page ? "active" : ""} onClick={() => onPage(item)} disabled={loading || item === page} aria-current={item === page ? "page" : undefined}>
            {item}
          </button>
        ))}
      </div>
      <span className="pageStatus">Page {page} of {totalPages}</span>
      <button onClick={() => onPage(page + 1)} disabled={loading || page >= totalPages}>Next</button>
    </nav>
  );
}

function paginationWindow(page: number, totalPages: number): Array<number | "ellipsis"> {
  const pages = new Set<number>([1, totalPages]);
  for (let item = page - 2; item <= page + 2; item += 1) {
    if (item >= 1 && item <= totalPages) pages.add(item);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  for (const item of sorted) {
    const previous = result[result.length - 1];
    if (typeof previous === "number" && item - previous > 1) result.push("ellipsis");
    result.push(item);
  }
  return result;
}

function BookmarkRow({
  bookmark,
  action,
  entering,
  onArchive,
  onRestore,
  onDelete,
  onSaveTags
}: {
  bookmark: Bookmark;
  action: BucketRowAction | null;
  entering: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onSaveTags: (tags: string[]) => Promise<unknown>;
}) {
  const bookmarkTagText = (bookmark.tags || []).join(", ");
  const [editingTags, setEditingTags] = useState(false);
  const [tagText, setTagText] = useState(bookmarkTagText);
  const busy = Boolean(action);

  useEffect(() => {
    if (!editingTags) setTagText(bookmarkTagText);
  }, [bookmarkTagText, editingTags]);

  async function saveTags() {
    await onSaveTags(tagText.split(",").map((item) => item.trim()).filter(Boolean));
    setEditingTags(false);
  }
  const href = safeHref(bookmark.url);
  const archiveHref = href ? `https://web.archive.org/web/*/${href}` : null;
  const rowClassName = [
    "row",
    "bookmark",
    action === "busy" ? "bookmark--busy" : "",
    action === "exiting" ? "bookmark--exiting" : "",
    entering ? "bookmark--entering" : ""
  ].filter(Boolean).join(" ");
  return (
    <article className={rowClassName}>
      <div className="rowMain">
        {href ? (
          <a className="title" href={href} target="_blank" rel="noreferrer">{bookmark.title || bookmark.url}</a>
        ) : (
          <span className="title">{bookmark.title || bookmark.url}</span>
        )}
        <span>{bookmark.domain || domain(bookmark.url)} · saved {dateLabel(bookmark.saved_at)}</span>
        <div className="tags">{(bookmark.tags || []).map((item) => <button key={item} onClick={() => navigator.clipboard.writeText(item)}>{item}</button>)}</div>
        {editingTags && (
          <div className="tagEdit">
            <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="writing, security" disabled={busy} />
            <button onClick={saveTags} disabled={busy}>Save tags</button>
          </div>
        )}
      </div>
      <div className="actions">
        <IconButton title="Tag" onClick={() => setEditingTags((value) => !value)} disabled={busy}><Tag size={16} /></IconButton>
        <IconLink href={archiveHref} title="Archive.org"><History className="archiveOrgIcon" size={18} /></IconLink>
        {bookmark.status !== "archived" && <IconButton title="Archive" onClick={onArchive} disabled={busy}><Archive size={16} /></IconButton>}
        {bookmark.status === "archived" && <IconButton title="Restore to bucket" onClick={onRestore} disabled={busy}><ArchiveRestore size={16} /></IconButton>}
        <IconButton title="Delete" onClick={onDelete} disabled={busy}><Trash2 size={16} /></IconButton>
      </div>
    </article>
  );
}

function Feeds() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [choices, setChoices] = useState<Array<{ title: string; feedUrl: string; siteUrl: string }>>([]);
  const [selectedFeedIds, setSelectedFeedIds] = useState<string[]>([]);
  const [bulkTagText, setBulkTagText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [feedBusy, setFeedBusy] = useState<Record<string, string>>({});

  async function load(force = false) {
    const cached = force ? null : readApiCache<{ feeds: Feed[] }>("/api/feeds", feedsCacheMs);
    if (cached) {
      setFeeds(cached.data.feeds);
      setSelectedFeedIds((ids) => ids.filter((id) => cached.data.feeds.some((feed) => feed.id === id)));
      if (cached.fresh) return;
    }
    const data = await api<{ feeds: Feed[] }>("/api/feeds");
    writeApiCache("/api/feeds", data, ["feeds", "feedTags"]);
    setFeeds(data.feeds);
    setSelectedFeedIds((ids) => ids.filter((id) => data.feeds.some((feed) => feed.id === id)));
  }
  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function add(event: FormEvent, feedUrl = url) {
    event.preventDefault();
    setMessage("Adding feed...");
    setChoices([]);
    try {
      await api("/api/feeds", { method: "POST", body: { url: feedUrl } });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      setUrl("");
      setMessage("Feed added.");
      await load(true);
    } catch (err) {
      const error = err as ApiError;
      if (error.data?.needsChoice) {
        setChoices(error.data.feeds);
        setMessage("Choose a feed.");
      } else {
        setMessage(error.message);
      }
    }
  }

  async function refresh(id: string) {
    await runFeedAction(id, "refresh", async () => {
      await api(`/api/feeds/${id}/refresh`, { method: "POST" });
      invalidateCacheTags(["feeds", "river", "bucket"]);
      await load(true);
    });
  }

  async function remove(id: string) {
    await runFeedAction(id, "remove", async () => {
      await api(`/api/feeds/${id}`, { method: "DELETE" });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      await load(true);
    });
  }

  async function toggleAutoSave(feed: Feed) {
    await runFeedAction(feed.id, "autoSave", async () => {
      await api(`/api/feeds/${feed.id}`, {
        method: "PATCH",
        body: { auto_save_to_bucket: feed.auto_save_to_bucket ? 0 : 1 }
      });
      invalidateCacheTags(["feeds", "river"]);
      await load(true);
    });
  }

  async function runFeedAction(feedId: string, action: string, callback: () => Promise<void>) {
    if (feedBusy[feedId]) return;
    setFeedBusy((items) => ({ ...items, [feedId]: action }));
    try {
      await callback();
    } finally {
      setFeedBusy((items) => {
        const next = { ...items };
        delete next[feedId];
        return next;
      });
    }
  }

  async function renameFeed(feed: Feed, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (trimmed === feed.title) return true;
    if (!trimmed) {
      setMessage("Feed name cannot be empty.");
      return false;
    }
    await runFeedAction(feed.id, "rename", async () => {
      await api(`/api/feeds/${feed.id}`, {
        method: "PATCH",
        body: { title: trimmed }
      });
      invalidateCacheTags(["feeds", "river"]);
      setMessage("Feed renamed.");
      await load(true);
    });
    return true;
  }

  async function removeFeedTag(feed: Feed, tag: string) {
    await runFeedAction(feed.id, `tag:${tag}`, async () => {
      await api(`/api/feeds/${feed.id}`, {
        method: "PATCH",
        body: { tags: (feed.tags || []).filter((item) => item !== tag) }
      });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      await Promise.all([load(true), warmDefaultRiverCache()]);
    });
  }

  async function saveFeedTags(feed: Feed, tags: string[]): Promise<boolean> {
    await runFeedAction(feed.id, "tags", async () => {
      await api(`/api/feeds/${feed.id}`, {
        method: "PATCH",
        body: { tags }
      });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      await Promise.all([load(true), warmDefaultRiverCache()]);
    });
    return true;
  }

  function toggleSelected(feedId: string) {
    setSelectedFeedIds((ids) => ids.includes(feedId) ? ids.filter((id) => id !== feedId) : [...ids, feedId]);
  }

  function selectAllFeeds() {
    setSelectedFeedIds(feeds.map((feed) => feed.id));
  }

  async function bulkDelete() {
    if (selectedFeedIds.length === 0 || bulkBusy) return;
    const count = selectedFeedIds.length;
    if (!window.confirm(`Delete ${count} selected feed${count === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true);
    setMessage(`Deleting ${count} feed${count === 1 ? "" : "s"}...`);
    try {
      const result = await api<{ deleted: number }>("/api/feeds/bulk-delete", {
        method: "POST",
        body: { feedIds: selectedFeedIds }
      });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      setSelectedFeedIds([]);
      setMessage(`Deleted ${result.deleted} feed${result.deleted === 1 ? "" : "s"}.`);
      await load(true);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkTag(event: FormEvent) {
    event.preventDefault();
    if (selectedFeedIds.length === 0 || bulkBusy) return;
    const tags = bulkTagText.split(",").map((item) => item.trim()).filter(Boolean);
    if (tags.length === 0) {
      setMessage("Enter at least one tag.");
      return;
    }

    setBulkBusy(true);
    setMessage(`Tagging ${selectedFeedIds.length} feed${selectedFeedIds.length === 1 ? "" : "s"}...`);
    try {
      const result = await api<{ updated: number }>("/api/feeds/bulk-tags", {
        method: "POST",
        body: { feedIds: selectedFeedIds, tags }
      });
      invalidateCacheTags(["feeds", "river", "feedTags"]);
      setBulkTagText("");
      setSelectedFeedIds([]);
      setMessage(`Tagged ${result.updated} feed${result.updated === 1 ? "" : "s"}.`);
      await Promise.all([load(true), warmDefaultRiverCache()]);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  const selectedCount = selectedFeedIds.length;
  const allSelected = feeds.length > 0 && selectedCount === feeds.length;

  return (
    <main className="page">
      <form className="inlineForm" onSubmit={add}>
        <input value={url} placeholder="Site URL or feed URL" onChange={(event) => setUrl(event.target.value)} />
        <button type="submit"><Plus size={16} /> Add feed</button>
      </form>
      {message && <p className="muted">{message}</p>}
      {choices.length > 0 && (
        <section className="choiceList">
          {choices.map((choice) => (
            <button key={choice.feedUrl} onClick={(event) => add(event, choice.feedUrl)}>
              {choice.title} <span>{choice.feedUrl}</span>
            </button>
          ))}
        </section>
      )}
      <section className="bulkBar" aria-label="Bulk feed actions">
        <div className="actions">
          <button type="button" onClick={allSelected ? () => setSelectedFeedIds([]) : selectAllFeeds} disabled={feeds.length === 0 || bulkBusy}>
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          <span className="bulkCount">{selectedCount} selected</span>
        </div>
        {selectedCount > 0 && (
          <form className="tagEdit bulkTagEdit" onSubmit={bulkTag}>
            <input
              value={bulkTagText}
              onChange={(event) => setBulkTagText(event.target.value)}
              placeholder="writing, security"
              disabled={bulkBusy}
            />
            <button type="submit" disabled={bulkBusy}>Apply tags</button>
            <IconButton title="Delete selected" onClick={bulkDelete} disabled={bulkBusy}><Trash2 size={16} /></IconButton>
          </form>
        )}
      </section>
      <div className="feedList">
        {feeds.map((feed) => {
          const feedHref = safeHref(feed.feed_url);
          const selected = selectedFeedIds.includes(feed.id);
          const busy = feedBusy[feed.id];
          return (
            <section className={`feedBlock compact ${selected ? "selected" : ""}`} key={feed.id}>
              <header>
                <div className="feedHeaderMain">
                  <label className="feedSelect">
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`Select ${feed.title}`}
                      onChange={() => toggleSelected(feed.id)}
                    />
                    <span aria-hidden="true"></span>
                  </label>
                  <div>
                    <FeedTitleEditor feed={feed} busy={busy === "rename"} onRename={renameFeed} />
                    {feedHref ? <a href={feedHref} target="_blank" rel="noreferrer">{feed.feed_url}</a> : <span>{feed.feed_url}</span>}
                    <FeedTagEditor
                      feed={feed}
                      busy={Boolean(busy)}
                      onRemoveTag={removeFeedTag}
                      onSaveTags={saveFeedTags}
                    />
                  </div>
                </div>
                <div className="actions">
                  <Toggle
                    checked={Boolean(feed.auto_save_to_bucket)}
                    label="Auto-bucket"
                    title="Bucket newly discovered articles from this feed"
                    onChange={() => toggleAutoSave(feed)}
                    disabled={Boolean(busy)}
                  />
                  <IconButton title="Refresh" onClick={() => refresh(feed.id)} disabled={Boolean(busy)}><RefreshCw size={16} /></IconButton>
                  <IconButton title="Remove" onClick={() => remove(feed.id)} disabled={Boolean(busy)}><Trash2 size={16} /></IconButton>
                </div>
              </header>
              <Status feed={feed} />
            </section>
          );
        })}
      </div>
    </main>
  );
}

function FeedTitleEditor({ feed, busy, onRename }: { feed: Feed; busy: boolean; onRename: (feed: Feed, title: string) => Promise<boolean> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurSaveRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(feed.title);

  useEffect(() => {
    if (!editing) setTitle(feed.title);
  }, [editing, feed.title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function beginEditing() {
    if (busy) return;
    setTitle(feed.title);
    setEditing(true);
  }

  async function commit() {
    if (skipBlurSaveRef.current) {
      skipBlurSaveRef.current = false;
      return;
    }
    const saved = await onRename(feed, title);
    if (saved) setEditing(false);
  }

  function cancelEditing() {
    skipBlurSaveRef.current = true;
    window.setTimeout(() => {
      skipBlurSaveRef.current = false;
    }, 0);
    setTitle(feed.title);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="feedTitleInput"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label={`Feed name for ${feed.title}`}
        disabled={busy}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelEditing();
          }
        }}
      />
    );
  }

  return (
    <button type="button" className="feedTitleButton" onClick={beginEditing} disabled={busy}>
      {feed.title}
    </button>
  );
}

function FeedTagEditor({
  feed,
  busy,
  onRemoveTag,
  onSaveTags
}: {
  feed: Feed;
  busy: boolean;
  onRemoveTag: (feed: Feed, tag: string) => Promise<void>;
  onSaveTags: (feed: Feed, tags: string[]) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurSaveRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [tags, setTags] = useState<string[]>(() => normalizeTags(feed.tags || []));
  const savedTags = normalizeTags(feed.tags || []);
  const savedKey = savedTags.join("\u0000");

  useEffect(() => {
    setTags(savedTags);
    setDraft("");
    setEditing(false);
  }, [savedKey]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing, tags.length]);

  function beginEditing() {
    if (busy) return;
    setEditing(true);
  }

  function commitDraft() {
    const next = normalizeTags([...tags, draft]);
    setTags(next);
    setDraft("");
  }

  async function saveIfChanged() {
    if (skipBlurSaveRef.current) {
      skipBlurSaveRef.current = false;
      return;
    }
    if (busy) return;
    const next = normalizeTags([...tags, draft]);
    setTags(next);
    setDraft("");
    if (next.join("\u0000") !== savedKey) {
      const saved = await onSaveTags(feed, next);
      if (!saved) return;
    }
    setEditing(false);
  }

  function cancelEditing() {
    skipBlurSaveRef.current = true;
    window.setTimeout(() => {
      skipBlurSaveRef.current = false;
    }, 0);
    setTags(savedTags);
    setDraft("");
    setEditing(false);
  }

  return (
    <div
      className={`chipEditor ${editing ? "editing" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          void saveIfChanged();
        }
      }}
    >
      {tags.map((item) => (
        <span className="tagChip" key={item}>
          <span>{item}</span>
          <button
            type="button"
            aria-label={`Remove tag ${item} from ${feed.title}`}
            onClick={() => {
              setTags((current) => current.filter((tag) => tag !== item));
              if (!editing) void onRemoveTag(feed, item);
            }}
            disabled={busy}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === ",") {
              event.preventDefault();
              commitDraft();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
          aria-label={`Add tag to ${feed.title}`}
          disabled={busy}
        />
      ) : (
        <button type="button" className="tagAddChip" onClick={beginEditing} disabled={busy} aria-label={`Add tag to ${feed.title}`}>
          <Plus size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function ImportExport() {
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const [bookmarkImporting, setBookmarkImporting] = useState(false);
  const [fullJsonImporting, setFullJsonImporting] = useState(false);

  async function importOpmlText(text: string) {
    if (importing) return;
    if (!text.trim()) {
      setMessage("Choose an OPML file first.");
      return;
    }
    try {
      const feeds = parseOpmlFeeds(text);
      if (feeds.length === 0) {
        setMessage("No feed URLs found in that OPML.");
        return;
      }
      setImporting(true);
      setMessage(`Found ${feeds.length} feeds.`);
      const totals: OpmlImportResult = { imported: 0, skipped: 0, ignored: 0, feedIds: [] };
      const batchSize = 10;
      for (let index = 0; index < feeds.length; index += batchSize) {
        const batch = feeds.slice(index, index + batchSize);
        const result = await api<OpmlImportResult>("/api/import/opml-feeds", { method: "POST", body: { feeds: batch } });
        totals.imported += result.imported;
        totals.skipped += result.skipped;
        totals.ignored += result.ignored;
        totals.feedIds.push(...result.feedIds);
        const processed = Math.min(index + batch.length, feeds.length);
        setMessage(`Imported ${processed}/${feeds.length} feeds...`);
      }
      const ignored = totals.ignored ? `; ignored ${totals.ignored} invalid` : "";
      if (totals.feedIds.length > 0) {
        setMessage(`Imported ${totals.imported}/${feeds.length} feeds; skipped ${totals.skipped} duplicates${ignored}. Refreshing imported feeds...`);
        const refresh = await refreshFeedsWithProgress(totals.feedIds, (progress) => {
          setMessage(`Refreshed ${progress.processed}/${progress.total} imported feeds; inserted ${progress.inserted} items...`);
        });
        const failed = refresh.failed ? `; ${refresh.failed} failed` : "";
        setMessage(`Imported ${totals.imported}/${feeds.length} feeds; skipped ${totals.skipped} duplicates${ignored}. Refreshed ${refresh.processed} feeds; inserted ${refresh.inserted} items${failed}.`);
      } else {
        setMessage(`Imported ${totals.imported}/${feeds.length} feeds; skipped ${totals.skipped} duplicates${ignored}.`);
      }
      invalidateCacheTags(["feeds", "river", "feedTags", "bucket"]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function importOpmlFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      await importOpmlText(text);
    } catch {
      setMessage("Could not read that OPML file.");
    }
  }

  async function importBookmarkFile(file: File | null) {
    if (!file || bookmarkImporting) return;
    try {
      const text = await file.text();
      const bookmarks = parseBookmarkImportFile(text, file.name);
      if (bookmarks.length === 0) {
        setMessage("No bookmark URLs found in that file.");
        return;
      }

      setBookmarkImporting(true);
      setMessage(`Found ${bookmarks.length} bookmarks.`);
      const totals: BookmarkImportResult = { imported: 0, skipped: 0, ignored: 0, bookmarkIds: [] };
      const batchSize = 50;
      for (let index = 0; index < bookmarks.length; index += batchSize) {
        const batch = bookmarks.slice(index, index + batchSize);
        const result = await api<BookmarkImportResult>("/api/import/bookmarks", { method: "POST", body: { bookmarks: batch } });
        totals.imported += result.imported;
        totals.skipped += result.skipped;
        totals.ignored += result.ignored;
        totals.bookmarkIds.push(...result.bookmarkIds);
        setMessage(`Imported ${Math.min(index + batch.length, bookmarks.length)}/${bookmarks.length} bookmarks...`);
      }
      const ignored = totals.ignored ? `; ignored ${totals.ignored} invalid` : "";
      setMessage(`Imported ${totals.imported}/${bookmarks.length} bookmarks; skipped ${totals.skipped} duplicates${ignored}.`);
      invalidateCacheTags(["bucket", "tags"]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bookmark import failed.");
    } finally {
      setBookmarkImporting(false);
    }
  }

  async function importFullJsonBundleFile(file: File | null) {
    if (!file || fullJsonImporting) return;
    try {
      const text = await file.text();
      if (!text.trim()) {
        setMessage("Choose a full JSON bundle first.");
        return;
      }

      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        setMessage("Could not parse that full JSON bundle.");
        return;
      }

      setFullJsonImporting(true);
      setMessage("Importing full JSON bundle...");
      const result = await api<FullJsonImportResult>("/api/import/all-json", { method: "POST", body: bundle });
      setMessage(formatFullJsonImportResult(result));
      invalidateCacheTags(["feeds", "river", "feedTags", "bucket", "tags"]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Full JSON bundle import failed.");
    } finally {
      setFullJsonImporting(false);
    }
  }

  return (
    <main className="page split">
      <section>
        <h2>Import OPML</h2>
        <FileImportTarget
          id="opmlImport"
          title="Import from file"
          hint="Drop an OPML or XML file here, or click to choose one."
          accept=".opml,.xml,text/xml,application/xml,text/plain"
          disabled={importing}
          onFile={importOpmlFile}
        />
        {message && <p className="muted">{message}</p>}
      </section>
      <section>
        <h2>Import bookmarks</h2>
        <FileImportTarget
          id="bookmarkImport"
          title="Import Riverbucket JSON or Netscape HTML"
          hint="Drop a JSON, HTML, or HTM file here, or click to choose one."
          accept=".json,.html,.htm,application/json,text/html,text/plain"
          disabled={bookmarkImporting}
          onFile={importBookmarkFile}
        />
      </section>
      <section>
        <h2>Import full JSON bundle</h2>
        <FileImportTarget
          id="fullJsonImport"
          title="Merge Riverbucket export"
          hint="Drop a full JSON bundle here, or click to choose one."
          accept=".json,application/json,text/plain"
          disabled={fullJsonImporting}
          onFile={importFullJsonBundleFile}
        />
      </section>
      <section>
        <h2>Export</h2>
        <div className="exportLinks">
          <a href="/api/export/opml?confirm=1">OPML subscriptions</a>
          <a href="/api/export/bookmarks.json?confirm=1">Bookmarks JSON</a>
          <a href="/api/export/bookmarks.html?confirm=1">Netscape bookmarks HTML</a>
          <a href="/api/export/all.json?confirm=1">Full JSON bundle</a>
        </div>
      </section>
    </main>
  );
}

function FileImportTarget({
  id,
  title,
  hint,
  accept,
  disabled,
  onFile
}: {
  id: string;
  title: string;
  hint: string;
  accept: string;
  disabled: boolean;
  onFile: (file: File | null) => Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    try {
      await onFile(event.currentTarget.files?.[0] || null);
    } finally {
      event.currentTarget.value = "";
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (disabled) return;
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false);
    }
  }

  async function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    await onFile(event.dataTransfer.files?.[0] || null);
  }

  return (
    <label
      className={`fileImport${dragging ? " dragging" : ""}${disabled ? " disabled" : ""}`}
      htmlFor={id}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-disabled={disabled}
    >
      <Upload size={18} aria-hidden="true" />
      <span className="fileImportText">
        <span className="fileImportTitle">{title}</span>
        <span className="fileImportHint">{hint}</span>
      </span>
      <input id={id} type="file" accept={accept} onChange={chooseFile} disabled={disabled} />
    </label>
  );
}

function formatFullJsonImportResult(result: FullJsonImportResult): string {
  const summaries = [
    result.feeds,
    result.feed_items,
    result.bookmarks,
    result.tags,
    result.bookmark_tags,
    result.feed_tags
  ];
  const totals = summaries.reduce(
    (total, item) => ({
      imported: total.imported + item.imported,
      skipped: total.skipped + item.skipped,
      ignored: total.ignored + item.ignored
    }),
    { imported: 0, skipped: 0, ignored: 0 }
  );
  const ignored = totals.ignored ? `; ignored ${totals.ignored} invalid` : "";
  return `Imported ${totals.imported} rows; skipped ${totals.skipped} existing${ignored}.`;
}

function Settings({ onLogout }: { onLogout: () => void }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState("Chrome");
  const [secret, setSecret] = useState("");

  async function load() {
    const data = await api<{ tokens: TokenRow[] }>("/api/extension-tokens");
    setTokens(data.tokens);
  }
  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const data = await api<{ secret: string }>("/api/extension-tokens", { method: "POST", body: { label } });
    setSecret(data.secret);
    await load();
  }

  async function revoke(id: string) {
    await api(`/api/extension-tokens/${id}/revoke`, { method: "POST" });
    await load();
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    clearApiCache();
    onLogout();
  }

  return (
    <main className="page split">
      <section>
        <h2>Extension token</h2>
        <form className="inlineForm" onSubmit={createToken}>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
          <button type="submit"><KeyRound size={16} /> Create token</button>
        </form>
        {secret && <p className="secret">{secret}</p>}
        <div className="tokenList">
          {tokens.map((token) => (
            <article className="row" key={token.id}>
              <div className="rowMain">
                <strong>{token.label || "Extension"}</strong>
                <span>created {dateLabel(token.created_at)}{token.revoked_at ? " · revoked" : ""}</span>
              </div>
              {!token.revoked_at && <IconButton title="Revoke" onClick={() => revoke(token.id)}><Trash2 size={16} /></IconButton>}
            </article>
          ))}
        </div>
      </section>
      <section>
        <h2>Session</h2>
        <button onClick={logout}>Log out</button>
      </section>
    </main>
  );
}

function Status({ feed, compact = false }: { feed: Feed; compact?: boolean }) {
  if (feed.last_error) return <p className={`status error ${compact ? "compact" : ""}`}>{feed.last_error}</p>;
  if (feed.last_success_at) {
    return (
      <p className={`status ${compact ? "compact" : ""}`}>
        fetched {compact ? <RelativeTime value={feed.last_success_at} /> : dateLabel(feed.last_success_at)}
      </p>
    );
  }
  return null;
}

function RelativeTime({ value, className }: { value: string; className?: string }) {
  return <span className={className} title={dateLabel(value)}>{shortAge(value)}</span>;
}

function Toggle({ checked, label, title, onChange, disabled = false }: { checked: boolean; label: string; title: string; onChange: () => void; disabled?: boolean }) {
  return (
    <button className={`toggle ${checked ? "on" : ""}`} title={title} aria-pressed={checked} onClick={onChange} disabled={disabled}>
      <span aria-hidden="true"></span>
      {label}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function IconButton({ children, title, onClick, disabled = false }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="icon" title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

function IconLink({ children, title, href }: { children: React.ReactNode; title: string; href: string | null }) {
  if (!href) return <span className="icon" title={title} aria-label={title} aria-disabled="true">{children}</span>;
  return <a className="icon" title={title} aria-label={title} href={href} target="_blank" rel="noreferrer">{children}</a>;
}

type ApiOptions = { method?: string; body?: unknown };
type ApiError = Error & { data?: any; status?: number };
type CacheTag = "river" | "bucket" | "feeds" | "feedTags" | "tags";
type CacheRecord<T> = { savedAt: number; tags: CacheTag[]; data: T };
type CacheHit<T> = { data: T; fresh: boolean };

const apiCachePrefix = "riverbucket:api:";
const memoryApiCache = new Map<string, CacheRecord<unknown>>();
let apiCacheGeneration = 0;

async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method || "GET",
    credentials: "include",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data: unknown = text;
  if (contentType.includes("json") && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && data.error
      ? String(data.error)
      : `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`;
    const error = new Error(message) as ApiError;
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

function isUnauthorizedApiError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as ApiError).status === 401;
}

function readApiCache<T>(path: string, ttlMs: number): CacheHit<T> | null {
  const key = apiCacheKey(path);
  const memory = memoryApiCache.get(key) as CacheRecord<T> | undefined;
  if (memory) return { data: memory.data, fresh: Date.now() - memory.savedAt <= ttlMs };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as CacheRecord<T>;
    if (!record || typeof record.savedAt !== "number") return null;
    memoryApiCache.set(key, record);
    return { data: record.data, fresh: Date.now() - record.savedAt <= ttlMs };
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function writeApiCache<T>(path: string, data: T, tags: CacheTag[]) {
  const key = apiCacheKey(path);
  const record: CacheRecord<T> = { savedAt: Date.now(), tags, data };
  memoryApiCache.set(key, record);
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Storage can be unavailable or full; the in-memory cache still handles tab switches.
  }
}

function warmRiverCaches(route: Extract<Route, { view: "river" }>, data: RiverResponse) {
  const alternateSort: RiverSort = route.sort === "newest" ? "title" : "newest";
  writeApiCache(riverPath(route), data, ["river", "feedTags"]);
  writeApiCache(riverPath({ ...route, sort: alternateSort }), {
    ...data,
    groups: sortRiverGroups(data.groups, alternateSort)
  }, ["river", "feedTags"]);
}

async function warmDefaultRiverCache() {
  const generation = apiCacheGeneration;
  const route: Extract<Route, { view: "river" }> = { view: "river", tag: "all", sort: "newest" };
  try {
    const data = await api<RiverResponse>(riverPath(route));
    if (generation === apiCacheGeneration) warmRiverCaches(route, data);
  } catch (err) {
    console.error(err);
  }
}

function sortRiverGroups(groups: RiverGroup[], sort: RiverSort): RiverGroup[] {
  return [...groups].sort((left, right) => {
    if (sort === "title") {
      return left.feed.title.localeCompare(right.feed.title, undefined, { sensitivity: "base" });
    }

    const leftLatest = latestRiverGroupTime(left.items);
    const rightLatest = latestRiverGroupTime(right.items);
    if (leftLatest && rightLatest && leftLatest !== rightLatest) return rightLatest.localeCompare(leftLatest);
    if (leftLatest && !rightLatest) return -1;
    if (!leftLatest && rightLatest) return 1;
    return left.feed.title.localeCompare(right.feed.title, undefined, { sensitivity: "base" });
  });
}

function latestRiverGroupTime(items: FeedItem[]): string | null {
  const item = items[0];
  return item ? item.published_at || item.discovered_at : null;
}

function invalidateCacheTags(tags: CacheTag[]) {
  apiCacheGeneration += 1;
  const wanted = new Set(tags);
  for (const [key, record] of memoryApiCache.entries()) {
    if (record.tags.some((tag) => wanted.has(tag))) memoryApiCache.delete(key);
  }
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key?.startsWith(apiCachePrefix)) continue;
      const record = JSON.parse(localStorage.getItem(key) || "{}") as CacheRecord<unknown>;
      if (record.tags?.some((tag) => wanted.has(tag as CacheTag))) localStorage.removeItem(key);
    }
  } catch {
    clearApiCache();
  }
}

function clearApiCache() {
  memoryApiCache.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(apiCachePrefix)) localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures during logout.
  }
}

function markCachedRiverItemSaved(itemId: string, itemUrl: string, bookmarkId: string) {
  updateCachedRecords<RiverResponse>("river", (data) => ({
    ...data,
    groups: data.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => item.id === itemId || item.url === itemUrl ? { ...item, saved_id: bookmarkId } : item)
    }))
  }));
}

function updateCachedRecords<T>(tag: CacheTag, update: (data: T) => T) {
  const keys = new Set<string>();
  for (const [key, record] of memoryApiCache.entries()) {
    if (record.tags.includes(tag)) keys.add(key);
  }
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(apiCachePrefix)) keys.add(key);
    }
  } catch {
    // Memory-only update is fine when storage is unavailable.
  }

  for (const key of keys) {
    const record = readRawCacheRecord<T>(key);
    if (!record?.tags.includes(tag)) continue;
    writeRawCacheRecord(key, { ...record, data: update(record.data) });
  }
}

function readRawCacheRecord<T>(key: string): CacheRecord<T> | null {
  const memory = memoryApiCache.get(key) as CacheRecord<T> | undefined;
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as CacheRecord<T> : null;
  } catch {
    return null;
  }
}

function writeRawCacheRecord<T>(key: string, record: CacheRecord<T>) {
  memoryApiCache.set(key, record);
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Keep the memory copy if persistent storage is unavailable.
  }
}

function apiCacheKey(path: string): string {
  return `${apiCachePrefix}${path}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortAge(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}M`;
  return `${Math.floor(months / 12)}y`;
}

function domain(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseOpmlFeeds(text: string): OpmlFeed[] {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error("Could not parse that OPML file.");
  }
  return Array.from(document.getElementsByTagName("outline")).flatMap((outline) => {
    const feedUrl = outline.getAttribute("xmlUrl") || outline.getAttribute("xmlurl");
    if (!feedUrl?.trim()) return [];
    const title = outline.getAttribute("title") || outline.getAttribute("text") || undefined;
    return [{ feedUrl: feedUrl.trim(), title: title?.trim() || undefined }];
  });
}

function parseBookmarkImportFile(text: string, filename: string): BookmarkImportInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (filename.toLowerCase().endsWith(".json") || trimmed.startsWith("{")) return parseRiverbucketBookmarksJson(trimmed);
  return parseNetscapeBookmarksHtml(text);
}

function parseRiverbucketBookmarksJson(text: string): BookmarkImportInput[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Could not parse that bookmarks JSON file.");
  }
  const bookmarks = (data as { bookmarks?: unknown }).bookmarks;
  if (!Array.isArray(bookmarks)) throw new Error("That JSON file does not look like a Riverbucket bookmarks export.");

  return bookmarks.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !isHttpUrl(row.url)) return [];
    const status = row.status === "archived" ? "archived" : "bucket";
    return [{
      url: row.url,
      title: cleanString(row.title),
      description: cleanString(row.description),
      canonical_url: typeof row.canonical_url === "string" && isHttpUrl(row.canonical_url) ? row.canonical_url : undefined,
      status,
      archived_at: status === "archived" ? cleanString(row.archived_at) : null,
      saved_at: parseImportDate(row.saved_at),
      notes: cleanString(row.notes),
      tags: Array.isArray(row.tags) ? uniqueStrings(row.tags) : []
    }];
  });
}

function parseNetscapeBookmarksHtml(text: string): BookmarkImportInput[] {
  const document = new DOMParser().parseFromString(text, "text/html");
  const root = document.querySelector("dl");
  if (!root) throw new Error("Could not find Netscape bookmark data in that HTML file.");
  const bookmarks: BookmarkImportInput[] = [];
  collectNetscapeBookmarks(root, [], bookmarks);
  return bookmarks;
}

function collectNetscapeBookmarks(dl: Element, folders: string[], bookmarks: BookmarkImportInput[]) {
  const children = Array.from(dl.children);
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child.tagName.toLowerCase() !== "dt") continue;
    const element = Array.from(child.children).find((node) => ["a", "h3", "dl"].includes(node.tagName.toLowerCase()));
    if (!element) continue;

    const tag = element.tagName.toLowerCase();
    if (tag === "a") {
      const url = element.getAttribute("href") || "";
      if (!isHttpUrl(url)) continue;
      bookmarks.push({
        url,
        title: element.textContent?.trim() || undefined,
        status: "bucket",
        saved_at: parseNetscapeDate(element.getAttribute("add_date")),
        tags: uniqueStrings(folders)
      });
      continue;
    }

    if (tag === "h3") {
      const folder = element.textContent?.trim();
      const nextFolders = folder ? [...folders, folder] : folders;
      const nested = Array.from(child.children).find((node) => node.tagName.toLowerCase() === "dl")
        || (children[index + 1]?.tagName.toLowerCase() === "dl" ? children[++index] : null);
      if (nested) collectNetscapeBookmarks(nested, nextFolders, bookmarks);
      continue;
    }

    if (tag === "dl") collectNetscapeBookmarks(element, folders, bookmarks);
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseImportDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseNetscapeDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function refreshFeedsWithProgress(
  feedIds: string[],
  onProgress: (progress: { processed: number; total: number; inserted: number; failed: number }) => void | Promise<void>,
  batchSize = 5
): Promise<{ processed: number; inserted: number; failed: number }> {
  const totals = { processed: 0, inserted: 0, failed: 0 };
  for (let index = 0; index < feedIds.length; index += batchSize) {
    const batch = feedIds.slice(index, index + batchSize);
    const result = await api<RefreshBatchResult>("/api/feeds/refresh-batch", {
      method: "POST",
      body: { feedIds: batch, limit: batchSize }
    });
    totals.processed += result.refreshed;
    totals.inserted += result.inserted;
    totals.failed += result.failed;
    await onProgress({ ...totals, total: feedIds.length });
  }
  return totals;
}

async function queueFeedRefresh(feedIds: string[]): Promise<RefreshQueueResult> {
  return api<RefreshQueueResult>("/api/feeds/refresh-batch", {
    method: "POST",
    body: { feedIds, async: true }
  });
}

function hasActiveRefreshClaims(data: RiverResponse): boolean {
  return data.groups.some(({ feed }) => Boolean(feed.refresh_claimed_at || feed.refresh_claim_id));
}

function hasActiveFeedRefreshClaims(feeds: Feed[]): boolean {
  return feeds.some((feed) => Boolean(feed.refresh_claimed_at || feed.refresh_claim_id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

createRoot(document.getElementById("root")!).render(<App />);
