import { describe, expect, it } from "vitest";
import { isBlockedFetchHost, normalizePublicHttpUrl } from "./url-safety";

describe("url safety", () => {
  it("normalizes public http URLs", () => {
    expect(normalizePublicHttpUrl("example.com/path#section")).toBe("https://example.com/path");
    expect(normalizePublicHttpUrl("/feed.xml", "https://example.com/blog/")).toBe("https://example.com/feed.xml");
  });

  it("rejects private and local hosts after URL canonicalization", () => {
    for (const value of [
      "http://localhost",
      "http://127.1",
      "http://2130706433",
      "http://0x7f000001",
      "http://0177.0.0.1",
      "http://10.0.0.1",
      "http://172.16.0.1",
      "http://192.168.1.1",
      "http://[::1]",
      "http://[fc00::1]",
      "http://[::ffff:127.0.0.1]"
    ]) {
      expect(() => normalizePublicHttpUrl(value), value).toThrow("URL host is not allowed");
    }
  });

  it("identifies blocked hostnames directly", () => {
    expect(isBlockedFetchHost("service.internal")).toBe(true);
    expect(isBlockedFetchHost("example.com")).toBe(false);
  });
});
