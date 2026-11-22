import { beforeEach, describe, expect, it } from "vitest";

import type { GatewayEnv } from "../src/auth";
import { handleFetch, resetRuntimeState } from "../src/index";
import { acceptOnce, FakeSocket } from "./fake-socket";
import { publishRequest, signedEvent } from "./helpers";

const env: GatewayEnv = {
  API_TOKEN: "test-token-value",
  ENVIRONMENT: "test",
  PUBLISH_ATTEMPT_TIMEOUT_MS: "80",
  PUBLISH_OVERALL_TIMEOUT_MS: "400",
};

beforeEach(() => {
  resetRuntimeState();
  FakeSocket.reset();
});

describe("deep health", () => {
  it("opens configured probe relays and does not publish an event", async () => {
    FakeSocket.queue.push((socket) => socket.open());
    const response = await handleFetch(
      new Request("https://gateway.example/health/deep"),
      { ...env, PROBE_RELAYS: "wss://relay.example" },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      reachable: 1,
      checked: 1,
      required: 1,
    });
    expect(FakeSocket.created[0]?.sent).toEqual([]);
    expect(FakeSocket.created.every((socket) => socket.closed)).toBe(true);
  });

  it("rejects unauthenticated production probes before opening a relay", async () => {
    const response = await handleFetch(
      new Request("https://gateway.example/health/deep"),
      { ENVIRONMENT: "production", PROBE_RELAYS: "wss://relay.example" },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "probe_auth_not_configured" });
    expect(FakeSocket.created).toEqual([]);
    const health = await handleFetch(new Request("https://gateway.example/health"), {
      ENVIRONMENT: "production",
    });
    expect(health.status).toBe(200);
  });

  it("rejects a wrong health token and reports partial relay availability", async () => {
    const denied = await handleFetch(
      new Request("https://gateway.example/health/deep", {
        headers: { authorization: "Bearer wrong" },
      }),
      { ...env, HEALTH_PROBE_TOKEN: "probe-secret", PROBE_RELAYS: "wss://relay.example" },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(denied.status).toBe(401);
    expect(FakeSocket.created).toEqual([]);
    FakeSocket.queue.push((socket) => socket.open());
    FakeSocket.queue.push((socket) => socket.emit("error", new Event("error")));
    const partial = await handleFetch(
      new Request("https://gateway.example/health/deep", {
        headers: { authorization: "Bearer probe-secret" },
      }),
      {
        ...env,
        HEALTH_PROBE_TOKEN: "probe-secret",
        PROBE_RELAYS: "wss://one.example,wss://two.example",
      },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      status: "degraded",
      checked: 2,
      reachable: 1,
      required: 2,
    });
    expect(FakeSocket.created.every((socket) => socket.closed)).toBe(true);
    expect(FakeSocket.created.every((socket) => socket.sent.length === 0)).toBe(true);
  });

  it("is misconfigured until probe relays are set", async () => {
    const response = await handleFetch(new Request("https://gateway.example/health/deep"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "misconfigured" });
  });
});

describe("http auth and limits", () => {
  it("fails closed when production has no token", async () => {
    const response = await handleFetch(publishRequest("https://gateway.example/publish", {}), {
      ENVIRONMENT: "production",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("publisher_auth_not_configured");
  });

  it("rejects a wrong token with a json body", async () => {
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish", {}, "wrong-token"),
      env,
    );
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain("unauthorized");
    expect(text).not.toContain("INVALID_TOKEN");
  });

  it("rejects an unknown route without a distinctive body", async () => {
    const response = await handleFetch(new Request("https://gateway.example/missing"), env);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("not_found");
    expect(text).not.toContain("Sooner and later");
  });

  it("rate limits the second publish", async () => {
    const limited = { ...env, RATE_LIMIT_REQUESTS: "1" };
    const first = await handleFetch(publishRequest("https://gateway.example/publish", {}), limited);
    const second = await handleFetch(
      publishRequest("https://gateway.example/publish", {}),
      limited,
    );
    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects an oversized body", async () => {
    const response = await handleFetch(
      new Request("https://gateway.example/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token-value",
          "content-length": "2000000",
        },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(413);
  });

  it("does not open a socket for a private relay in production", async () => {
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish", {
        relays: ["wss://127.0.0.1/"],
        event: signedEvent(),
      }),
      { ...env, ENVIRONMENT: "production", ALLOW_PRIVATE_RELAYS: "true" },
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(400);
    expect(FakeSocket.created).toHaveLength(0);
  });
});

describe("publishing", () => {
  it("reports partial relay success", async () => {
    const event = signedEvent();
    FakeSocket.queue.push(acceptOnce, (socket) => {
      socket.open();
      const sent = socket.sent[0];
      if (!sent) throw new Error("missing event");
      const parsed = JSON.parse(sent) as [string, { id: string }];
      socket.message(JSON.stringify(["OK", parsed[1].id, false, "blocked"]));
    });
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish", {
        relays: ["wss://one.example/", "wss://two.example/"],
        event,
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; results: Array<{ outcome: string }> };
    expect(body.status).toBe("partial");
    expect(body.results.map((item) => item.outcome)).toEqual(["accepted", "rejected"]);
    expect(FakeSocket.created.every((socket) => socket.closed)).toBe(true);
  });

  it("treats a duplicate acknowledgement as accepted and does not retry a rejection", async () => {
    const event = signedEvent();
    FakeSocket.queue.push((socket) => {
      socket.open();
      const sent = socket.sent[0];
      if (!sent) throw new Error("missing event");
      const parsed = JSON.parse(sent) as [string, { id: string }];
      socket.message(
        JSON.stringify(["OK", parsed[1].id, false, "duplicate: already have this event"]),
      );
    });
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish?policy=aggressive", {
        relays: ["wss://one.example/"],
        event,
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    const body = (await response.json()) as { status: string; results: Array<{ outcome: string }> };
    expect(body.status).toBe("accepted");
    expect(body.results[0]?.outcome).toBe("duplicate");
    expect(FakeSocket.created).toHaveLength(1);
  });

  it("retries a timeout and then accepts", async () => {
    const event = signedEvent();
    FakeSocket.queue.push((socket) => {
      socket.open();
    }, acceptOnce);
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish", {
        relays: ["wss://one.example/"],
        event,
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("accepted");
    expect(FakeSocket.created).toHaveLength(2);
  });

  it("opens the circuit after transport failures", async () => {
    FakeSocket.queue.push(
      (socket) => socket.emit("error", new Event("error")),
      (socket) => socket.emit("error", new Event("error")),
      (socket) => socket.emit("error", new Event("error")),
      (socket) => socket.emit("error", new Event("error")),
      (socket) => socket.emit("error", new Event("error")),
    );
    const event = signedEvent();
    const send = () =>
      handleFetch(
        publishRequest("https://gateway.example/publish?policy=aggressive", {
          relays: ["wss://one.example/"],
          event,
        }),
        env,
        undefined,
        { webSocket: FakeSocket as unknown as typeof WebSocket },
      );
    for (let count = 0; count < 4; count += 1) {
      const response = await send();
      const body = (await response.json()) as { results: Array<{ outcome: string }> };
      expect(body.results[0]?.outcome).toBe("connection_failed");
    }
    const opened = await send();
    const body = (await opened.json()) as { results: Array<{ outcome: string }> };
    expect(body.results[0]?.outcome).toBe("circuit_open");
    expect(FakeSocket.created).toHaveLength(4);
  });

  it("validates a batch before publishing any event", async () => {
    const good = signedEvent({ content: "one" });
    const bad = { ...signedEvent({ content: "two" }), content: "tampered" };
    const response = await handleFetch(
      publishRequest("https://gateway.example/batch", {
        relays: ["wss://one.example/"],
        events: [good, bad],
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    expect(response.status).toBe(400);
    expect(FakeSocket.created).toHaveLength(0);
  });

  it("publishes a valid batch", async () => {
    FakeSocket.queue.push(acceptOnce, acceptOnce);
    const response = await handleFetch(
      publishRequest("https://gateway.example/batch", {
        relays: ["wss://one.example/"],
        events: [signedEvent({ content: "one" }), signedEvent({ content: "two" })],
      }),
      env,
      undefined,
      { webSocket: FakeSocket as unknown as typeof WebSocket },
    );
    const body = (await response.json()) as { status: string; events: unknown[] };
    expect(response.status).toBe(200);
    expect(body.status).toBe("accepted");
    expect(body.events).toHaveLength(2);
  });

  it("cancels an in-flight publish and closes the socket", async () => {
    const controller = new AbortController();
    FakeSocket.queue.push((socket) => {
      socket.open();
      controller.abort();
    });
    const request = publishRequest("https://gateway.example/publish?policy=aggressive", {
      relays: ["wss://one.example/"],
      event: signedEvent(),
    });
    Object.defineProperty(request, "signal", { value: controller.signal });
    const response = await handleFetch(request, env, undefined, {
      webSocket: FakeSocket as unknown as typeof WebSocket,
    });
    const body = (await response.json()) as { results: Array<{ outcome: string }> };
    expect(body.results[0]?.outcome).toBe("cancelled");
    expect(FakeSocket.created[0]?.closed).toBe(true);
  });
});
