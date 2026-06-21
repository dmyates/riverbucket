import { describe, expect, it } from "vitest";
import {
  completeScheduledRefreshJob,
  getDueFeedClaimOrderBy,
  recentFeedItemsQuery,
  riverQueryFeedBatchSize,
  savedFeedItemLookupQuery,
  scheduledRefreshTimestamp,
  selectFeedItemsForRefresh
} from "./index";

function item(id: string, publishedAt?: string) {
  return {
    guid: id,
    url: `https://example.com/${id}`,
    title: id,
    publishedAt
  };
}

describe("selectFeedItemsForRefresh", () => {
  it("selects newest items when a feed is oldest-first", () => {
    const selected = selectFeedItemsForRefresh([
      item("old", "2026-01-01T00:00:00.000Z"),
      item("middle", "2026-01-02T00:00:00.000Z"),
      item("new", "2026-01-03T00:00:00.000Z")
    ]);

    expect(selected.map((entry) => entry.guid)).toEqual(["new", "middle", "old"]);
  });

  it("preserves source order when dates are missing or tied", () => {
    const selected = selectFeedItemsForRefresh([
      item("first"),
      item("second", "not-a-date"),
      item("third")
    ]);

    expect(selected.map((entry) => entry.guid)).toEqual(["first", "second", "third"]);
  });

  it("limits selection to the refresh item cap", () => {
    const selected = selectFeedItemsForRefresh(
      Array.from({ length: 12 }, (_, index) => item(String(index), `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`))
    );

    expect(selected).toHaveLength(10);
    expect(selected.map((entry) => entry.guid)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
  });
});

describe("dueFeedClaimOrderBy", () => {
  const dueFeedClaimOrderBy = getDueFeedClaimOrderBy();

  it("prioritizes never-fetched feeds first", () => {
    expect(dueFeedClaimOrderBy).toContain("last_fetched_at IS NULL DESC");
  });

  it("guards against starving badly overdue feeds", () => {
    expect(dueFeedClaimOrderBy).toContain("fetch_interval_minutes * 2");
    expect(dueFeedClaimOrderBy).toContain("datetime(last_fetched_at, '+' || fetch_interval_minutes || ' minutes')");
  });

  it("uses latest known feed item freshness before oldest-fetch fallback", () => {
    const latestItemIndex = dueFeedClaimOrderBy.indexOf("latest.latest_item_time DESC");
    const fallbackIndex = dueFeedClaimOrderBy.indexOf("COALESCE(last_fetched_at, created_at) ASC");

    expect(latestItemIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(latestItemIndex).toBeLessThan(fallbackIndex);
  });
});

describe("savedFeedItemLookupQuery", () => {
  it("uses one parameter per feed and stays within D1's parameter limit", () => {
    const query = savedFeedItemLookupQuery(riverQueryFeedBatchSize);

    expect(query.match(/\?/g)).toHaveLength(riverQueryFeedBatchSize);
    expect(riverQueryFeedBatchSize).toBeLessThanOrEqual(100);
  });

  it("matches saved items by source item ID and exact URL", () => {
    const query = savedFeedItemLookupQuery(1);

    expect(query).toContain("source_bookmark.source_feed_item_id = selected_items.id");
    expect(query).toContain("url_bookmark.url = selected_items.url");
    expect(query).toContain("COALESCE(source_bookmark.id, url_bookmark.id)");
  });
});

describe("recentFeedItemsQuery", () => {
  it("selects only fields used by the River response", () => {
    const query = recentFeedItemsQuery(2);

    expect(query.match(/\?/g)).toHaveLength(3);
    expect(query).toContain("id, feed_id, url, title, published_at, discovered_at");
    expect(query).not.toMatch(/\bsummary\b/);
    expect(query).not.toMatch(/\bauthor\b/);
    expect(query).not.toMatch(/\bguid\b/);
    expect(query).not.toMatch(/\bcanonical_url\b/);
    expect(query).not.toMatch(/\braw_hash\b/);
    expect(query).not.toContain("SELECT *");
  });
});

describe("scheduled feed refreshes", () => {
  it("uses the cron event time as the feed refresh timestamp", () => {
    expect(scheduledRefreshTimestamp(Date.UTC(2026, 5, 21, 12, 0, 0)))
      .toBe("2026-06-21T12:00:00.000Z");
  });

  it("completes and announces a scheduled batch exactly once", async () => {
    const completionTokens = new Map<string, string>();
    let completedJobs = 0;
    let notified = false;
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return this;
          },
          async run() {
            if (sql.includes("UPDATE feed_refresh_batch_jobs")) {
              const feedId = String(values[3]);
              if (completionTokens.has(feedId)) return { meta: { changes: 0 } };
              completionTokens.set(feedId, String(values[1]));
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET completed_jobs = completed_jobs + 1")) {
              const feedId = String(values[2]);
              if (completionTokens.get(feedId) !== String(values[3])) return { meta: { changes: 0 } };
              completedJobs += 1;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET notified_at =")) {
              if (completedJobs < 2 || notified) return { meta: { changes: 0 } };
              notified = true;
              return { meta: { changes: 1 } };
            }
            throw new Error(`Unexpected query: ${sql}`);
          }
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }
    } as unknown as D1Database;
    const env = { DB: db } as Parameters<typeof completeScheduledRefreshJob>[0];

    await expect(completeScheduledRefreshJob(env, "batch", "feed-1")).resolves.toBe(false);
    await expect(completeScheduledRefreshJob(env, "batch", "feed-1")).resolves.toBe(false);
    await expect(completeScheduledRefreshJob(env, "batch", "feed-2")).resolves.toBe(true);
    await expect(completeScheduledRefreshJob(env, "batch", "feed-2")).resolves.toBe(false);
  });
});
