import { describe, expect, it } from "vitest";

import { createCircuitBreaker } from "../src/relay/circuit";

describe("circuit breaker", () => {
  it("opens after repeated transport failures and allows one later trial", () => {
    let now = 1_000;
    const breaker = createCircuitBreaker({ threshold: 2, openMs: 500, now: () => now });
    expect(breaker.allow("wss://relay.example")).toBe(true);
    breaker.fail("wss://relay.example");
    expect(breaker.allow("wss://relay.example")).toBe(true);
    breaker.fail("wss://relay.example");
    expect(breaker.allow("wss://relay.example")).toBe(false);
    now += 500;
    expect(breaker.allow("wss://relay.example")).toBe(true);
    expect(breaker.allow("wss://relay.example")).toBe(false);
    breaker.succeed("wss://relay.example");
    expect(breaker.allow("wss://relay.example")).toBe(true);
  });
});
