import { describe, expect, it } from "vitest";

import { normalizeRelayList, normalizeRelayUrl } from "../src/relay/address";

describe("relay addresses", () => {
  it("keeps a public wss url and drops the query", () => {
    expect(normalizeRelayUrl("wss://Relay.Example/path/", false)).toEqual({
      ok: true,
      url: "wss://relay.example/path",
    });
    expect(normalizeRelayUrl("wss://relay.example/?x=1", false).ok).toBe(false);
  });

  it("blocks loopback, private, link-local, and metadata hosts", () => {
    for (const input of [
      "wss://127.0.0.1/",
      "wss://10.1.1.1/",
      "wss://192.168.1.8/",
      "wss://169.254.169.254/",
      "wss://metadata.google.internal/",
      "ws://localhost/",
      "http://relay.example/",
      "wss://user:secret@relay.example/",
      "wss://2130706433/",
    ]) {
      expect(normalizeRelayUrl(input, false).ok).toBe(false);
    }
  });

  it("allows a loopback ws relay only when private relays are enabled", () => {
    expect(normalizeRelayUrl("ws://127.0.0.1:8080/relay", false).ok).toBe(false);
    expect(normalizeRelayUrl("ws://127.0.0.1:8080/relay", true)).toEqual({
      ok: true,
      url: "ws://127.0.0.1:8080/relay",
    });
    expect(normalizeRelayUrl("ws://relay.example/", true).ok).toBe(false);
  });

  it("deduplicates and caps the list", () => {
    const many = Array.from({ length: 13 }, (_, index) => `wss://relay-${index}.example/`);
    expect(normalizeRelayList(many, false, 12).ok).toBe(false);
    const listed = normalizeRelayList(["wss://relay.example/", "WSS://relay.example"], false, 12);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.urls).toEqual(["wss://relay.example"]);
  });
});
