import { describe, expect, it } from "vitest";
import {
  getDueFeedClaimOrderBy,
  riverQueryFeedBatchSize,
  savedFeedItemLookupQuery,
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
