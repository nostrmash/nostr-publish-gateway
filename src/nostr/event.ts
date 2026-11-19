import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const ID_HEX = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;
const MAX_CONTENT = 256_000;
const MAX_TAGS = 2_000;
const MAX_TAG_ITEMS = 50;
const MAX_TAG_VALUE = 4_096;
const FUTURE_SKEW_SECONDS = 86_400;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type EventResult = { ok: true; event: NostrEvent } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalEventBytes(
  event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">,
): Uint8Array {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return new TextEncoder().encode(serialized);
}

export function eventIdFor(
  event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">,
): string {
  return bytesToHex(sha256(canonicalEventBytes(event)));
}

function parseTags(value: unknown): string[][] | string {
  if (!Array.isArray(value)) return "tags must be an array";
  if (value.length > MAX_TAGS) return "too many tags";
  const tags: string[][] = [];
  for (const tag of value) {
    if (!Array.isArray(tag)) return "each tag must be an array of strings";
    if (tag.length > MAX_TAG_ITEMS) return "a tag has too many values";
    const items: string[] = [];
    for (const item of tag) {
      if (typeof item !== "string") return "tag values must be strings";
      if (item.length > MAX_TAG_VALUE) return "a tag value is too long";
      items.push(item);
    }
    tags.push(items);
  }
  return tags;
}

/**
 * NIP-01 event check. The id is SHA-256 of the canonical array. The signature
 * is BIP-340 Schnorr over that 32-byte id. Lowercase hex is required.
 */
export function parseSignedEvent(value: unknown, nowSeconds: number): EventResult {
  if (!isRecord(value)) return { ok: false, reason: "event must be an object" };
  const id = value.id;
  const pubkey = value.pubkey;
  const createdAt = value.created_at;
  const kind = value.kind;
  const content = value.content;
  const sig = value.sig;
  if (typeof id !== "string" || !ID_HEX.test(id))
    return { ok: false, reason: "event id must be 64 lowercase hex characters" };
  if (typeof pubkey !== "string" || !ID_HEX.test(pubkey)) {
    return { ok: false, reason: "pubkey must be 64 lowercase hex characters" };
  }
  if (typeof sig !== "string" || !SIG_HEX.test(sig)) {
    return { ok: false, reason: "signature must be 128 lowercase hex characters" };
  }
  if (typeof content !== "string") return { ok: false, reason: "content must be a string" };
  if (content.length > MAX_CONTENT) return { ok: false, reason: "content is too long" };
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt) || createdAt < 0) {
    return { ok: false, reason: "created_at must be a non-negative integer" };
  }
  if (createdAt > nowSeconds + FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "created_at is too far in the future" };
  }
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 65_535) {
    return { ok: false, reason: "kind must be an integer from 0 through 65535" };
  }
  const tags = parseTags(value.tags);
  if (typeof tags === "string") return { ok: false, reason: tags };
  const event: NostrEvent = { id, pubkey, created_at: createdAt, kind, tags, content, sig };
  if (eventIdFor(event) !== id) return { ok: false, reason: "event id does not match the event" };
  try {
    const valid = schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey));
    if (!valid) return { ok: false, reason: "invalid signature" };
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  return { ok: true, event };
}
