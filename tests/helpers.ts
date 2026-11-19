import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import type { NostrEvent } from "../src/nostr/event";

export function signedEvent(input?: {
  content?: string;
  kind?: number;
  privateKey?: Uint8Array;
  createdAt?: number;
  tags?: string[][];
}): NostrEvent {
  const secret = input?.privateKey ?? schnorr.utils.randomPrivateKey();
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const created_at = input?.createdAt ?? Math.floor(Date.now() / 1000);
  const kind = input?.kind ?? 1;
  const tags = input?.tags ?? [];
  const content = input?.content ?? "hello";
  const id = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))),
  );
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

export function publishRequest(url: string, body: unknown, token = "test-token-value"): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
