import { describe, expect, it } from "vitest";
import { HttpError, readJson } from "./http";

describe("readJson", () => {
  it("parses JSON bodies within the configured size", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: JSON.stringify({ ok: true })
    });
    await expect(readJson<{ ok: boolean }>(request, 128)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized bodies", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(64) })
    });
    await expect(readJson(request, 16)).rejects.toMatchObject(new HttpError(413, "Request body too large"));
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: "{nope"
    });
    await expect(readJson(request, 128)).rejects.toMatchObject(new HttpError(400, "Malformed JSON"));
  });
});
