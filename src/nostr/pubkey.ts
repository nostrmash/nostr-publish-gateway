import { bech32 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * Accept a lowercase hex pubkey or an npub. Secret keys are rejected.
 * NIP-19 npub data is 32 bytes. The bech32 length limit is the npub size,
 * not a general decoder budget.
 */
export function parsePubkey(
  value: string,
): { ok: true; pubkey: string } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("nsec")) return { ok: false, reason: "secret keys are not accepted" };
  if (HEX_PUBKEY.test(trimmed)) return { ok: true, pubkey: trimmed };
  if (!trimmed.startsWith("npub1"))
    return { ok: false, reason: "pubkey must be 64 hex characters or an npub" };
  try {
    const decoded = bech32.decode(trimmed as `${string}1${string}`, 90);
    if (decoded.prefix !== "npub") return { ok: false, reason: "pubkey must be an npub" };
    const data = bech32.fromWords(decoded.words);
    if (data.length !== 32) return { ok: false, reason: "npub payload must be 32 bytes" };
    return { ok: true, pubkey: bytesToHex(data) };
  } catch {
    return { ok: false, reason: "npub could not be decoded" };
  }
}
