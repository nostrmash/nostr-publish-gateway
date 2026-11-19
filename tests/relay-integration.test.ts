import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import type { GatewayEnv } from "../src/auth";
import { handleFetch, resetRuntimeState } from "../src/index";
import { publishRequest, signedEvent } from "./helpers";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  resetRuntimeState();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(): Promise<{ url: string; server: WebSocketServer }> {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  servers.push(server);
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${address.port}`, server });
    });
  });
}

describe("disposable relay", () => {
  it("publishes a signed event and records a negative acknowledgement", async () => {
    const accepted = await listen();
    const rejected = await listen();
    accepted.server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as [string, { id: string }];
        socket.send(JSON.stringify(["OK", parsed[1].id, true, ""]));
      });
    });
    rejected.server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as [string, { id: string }];
        socket.send(JSON.stringify(["OK", parsed[1].id, false, "rejected: test relay"]));
      });
    });
    const env: GatewayEnv = {
      API_TOKEN: "test-token-value",
      ENVIRONMENT: "test",
      ALLOW_PRIVATE_RELAYS: "true",
      PUBLISH_ATTEMPT_TIMEOUT_MS: "2000",
      PUBLISH_OVERALL_TIMEOUT_MS: "4000",
    };
    const response = await handleFetch(
      publishRequest("https://gateway.example/publish?policy=aggressive", {
        relays: [accepted.url, rejected.url],
        event: signedEvent({ content: "disposable relay" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      results: Array<{ outcome: string; accepted: boolean }>;
    };
    expect(body.status).toBe("partial");
    expect(body.results[0]).toMatchObject({ outcome: "accepted", accepted: true });
    expect(body.results[1]).toMatchObject({ outcome: "rejected", accepted: false });
  });
});
