import { bech32 } from "@scure/base";
import { hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import { eventIdFor, parseSignedEvent } from "../src/nostr/event";
import { parsePubkey } from "../src/nostr/pubkey";
import { signedEvent } from "./helpers";

describe("signed events", () => {
  it("accepts an event signed for its canonical id", () => {
    const event = signedEvent({ content: "independent" });
    expect(parseSignedEvent(event, event.created_at).ok).toBe(true);
  });

  it("rejects an id that does not match the content", () => {
    const event = signedEvent();
    const tampered = { ...event, content: "changed" };
    const result = parseSignedEvent(tampered, event.created_at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("event id");
  });

  it("rejects a signature that does not match the id", () => {
    const event = signedEvent();
    const flipped = event.sig.endsWith("a")
      ? `${event.sig.slice(0, -1)}b`
      : `${event.sig.slice(0, -1)}a`;
    const result = parseSignedEvent({ ...event, sig: flipped }, event.created_at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("signature");
  });

  it("rejects uppercase hex and a created_at too far ahead", () => {
    const event = signedEvent();
    expect(parseSignedEvent({ ...event, id: event.id.toUpperCase() }, event.created_at).ok).toBe(
      false,
    );
    expect(
      parseSignedEvent({ ...event, created_at: event.created_at + 90_000 }, event.created_at).ok,
    ).toBe(false);
  });

  it("computes the id the same way the signer did", () => {
    const event = signedEvent({ tags: [["t", "nostr"]] });
    expect(eventIdFor(event)).toBe(event.id);
  });
});

describe("pubkeys", () => {
  it("decodes an npub and rejects a secret-key prefix", () => {
    const event = signedEvent();
    const npub = bech32.encode("npub", bech32.toWords(hexToBytes(event.pubkey)), 90);
    expect(parsePubkey(npub)).toEqual({ ok: true, pubkey: event.pubkey });
    expect(
      parsePubkey("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq").ok,
    ).toBe(false);
  });
});
