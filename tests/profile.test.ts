import { beforeEach, describe, expect, it } from "vitest";

import type { GatewayEnv, ProfileKv } from "../src/auth";
import { handleFetch, resetRuntimeState } from "../src/index";
import { parseSignedEvent } from "../src/nostr/event";
import { FakeSocket } from "./fake-socket";
import { publishRequest, signedEvent } from "./helpers";

function memoryKv(): ProfileKv & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  resetRuntimeState();
  FakeSocket.reset();
});

describe("profile lookup", () => {
  it("returns a signed kind 0 event and serves it fresh from cache", async () => {
    const profile = signedEvent({ kind: 0, content: JSON.stringify({ name: "Ada" }) });
    const kv = memoryKv();
    const env: GatewayEnv = {
      API_TOKEN: "test-token-value",
      ENVIRONMENT: "test",
      PROFILES: kv,
    };
    FakeSocket.queue.push((socket) => {
      socket.open();
      const sent = socket.sent[0];
      if (!sent) throw new Error("missing request");
      const parsed = JSON.parse(sent) as [string, string];
      socket.message(JSON.stringify(["EVENT", parsed[1], profile]));
      socket.message(JSON.stringify(["EOSE", parsed[1]]));
    });
    const first = await handleFetch(
      publishRequest("https://gateway.example/profile", {
        pubkey: profile.pubkey,
        relays: ["wss://profiles.example/"],
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(first.status).toBe(200);
    const created = (await first.json()) as { cache: string; profile: unknown };
    expect(created.cache).toBe("miss");
    expect(parseSignedEvent(created.profile, profile.created_at).ok).toBe(true);

    FakeSocket.reset();
    const second = await handleFetch(
      publishRequest("https://gateway.example/profile", {
        pubkey: profile.pubkey,
        relays: ["wss://profiles.example/"],
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    const cached = (await second.json()) as { cache: string };
    expect(cached.cache).toBe("fresh");
    expect(FakeSocket.created).toHaveLength(0);
  });

  it("returns 404 when the relay has no profile", async () => {
    FakeSocket.queue.push((socket) => {
      socket.open();
      const sent = socket.sent[0];
      if (!sent) throw new Error("missing request");
      const parsed = JSON.parse(sent) as [string, string];
      socket.message(JSON.stringify(["EOSE", parsed[1]]));
    });
    const response = await handleFetch(
      publishRequest("https://gateway.example/profile", {
        pubkey: signedEvent().pubkey,
        relays: ["wss://profiles.example/"],
      }),
      { API_TOKEN: "test-token-value", ENVIRONMENT: "test" },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(404);
  });
});
