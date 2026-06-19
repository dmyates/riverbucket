import { describe, expect, it } from "vitest";
import { AppSync } from "./index";

class TestSocket {
  sent: string[] = [];
  closed = false;

  constructor(private readonly clientId: string) {}

  deserializeAttachment() {
    return { clientId: this.clientId };
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }
}

function createSync(sockets: TestSocket[]) {
  const state = {
    getWebSockets: () => sockets
  } as unknown as DurableObjectState;
  return new AppSync(state);
}

describe("AppSync publishing", () => {
  it("broadcasts normalized scopes while excluding the source tab", async () => {
    const source = new TestSocket("source-client");
    const peer = new TestSocket("peer-client");
    const sync = createSync([source, peer]);

    const response = await sync.fetch(new Request("https://app-sync/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "app.invalidate",
        scopes: ["bucket", "bucket", "unknown", "river"],
        sourceClientId: "source-client"
      })
    }));

    expect(response.status).toBe(200);
    expect(source.sent).toEqual([]);
    expect(peer.sent).toEqual([
      JSON.stringify({ type: "app.invalidate", scopes: ["bucket", "river"] })
    ]);
    await expect(response.json()).resolves.toEqual({ ok: true, delivered: 1 });
  });

  it("broadcasts background changes to every connected tab", async () => {
    const first = new TestSocket("first-client");
    const second = new TestSocket("second-client");
    const sync = createSync([first, second]);

    await sync.fetch(new Request("https://app-sync/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "app.invalidate",
        scopes: ["feeds"]
      })
    }));

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  it("rejects malformed publish events", async () => {
    const sync = createSync([]);
    const response = await sync.fetch(new Request("https://app-sync/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "other", scopes: ["river"] })
    }));

    expect(response.status).toBe(400);
  });
});
