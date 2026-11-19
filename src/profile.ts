import type { GatewayEnv, ProfileKv } from "./auth";
import { HttpError } from "./http";
import { parseSignedEvent, type NostrEvent } from "./nostr/event";
import type { RelaySocket, RelaySocketConstructor } from "./relay/publish";

const FRESH_MS = 10 * 60 * 1000;
const SERVE_MS = 2 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 6 * 60 * 60;

interface CachedProfile {
  storedAt: number;
  event: NostrEvent;
}

function cacheKey(pubkey: string): string {
  return `kind0:${pubkey}`;
}

async function readCache(
  kv: ProfileKv,
  pubkey: string,
  now: number,
): Promise<CachedProfile | null> {
  const raw = await kv.get(cacheKey(pubkey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { storedAt?: unknown; event?: unknown };
    if (typeof parsed.storedAt !== "number") return null;
    const checked = parseSignedEvent(parsed.event, Math.floor(now / 1000) + 86_400);
    if (!checked.ok || checked.event.kind !== 0 || checked.event.pubkey !== pubkey) return null;
    if (now - parsed.storedAt > SERVE_MS) return null;
    return { storedAt: parsed.storedAt, event: checked.event };
  } catch {
    return null;
  }
}

async function writeCache(
  kv: ProfileKv,
  pubkey: string,
  event: NostrEvent,
  now: number,
): Promise<void> {
  await kv.put(cacheKey(pubkey), JSON.stringify({ storedAt: now, event }), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

function messageText(event: Event): string | null {
  if (!("data" in event)) return null;
  return typeof event.data === "string" ? event.data : null;
}

function fetchKind0(
  pubkey: string,
  relays: string[],
  timeoutMs: number,
  Socket: RelaySocketConstructor,
  nowSeconds: number,
): Promise<NostrEvent | null> {
  const subId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return new Promise((resolve) => {
    let index = 0;
    let current: RelaySocket | null = null;
    let settled = false;
    const candidates: NostrEvent[] = [];
    const best = (): NostrEvent | null => {
      let selected: NostrEvent | null = null;
      for (const event of candidates) {
        if (!selected || event.created_at >= selected.created_at) selected = event;
      }
      return selected;
    };
    const finish = (event: NostrEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        current?.close();
      } catch {
        /* already closed */
      }
      resolve(event);
    };
    const timer = setTimeout(() => finish(best()), timeoutMs);
    const openNext = () => {
      if (settled) return;
      const relay = relays[index];
      index += 1;
      if (!relay) {
        finish(best());
        return;
      }
      let moved = false;
      const move = () => {
        if (moved || settled) return;
        moved = true;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        openNext();
      };
      let socket: RelaySocket;
      try {
        socket = new Socket(relay);
      } catch {
        openNext();
        return;
      }
      current = socket;
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify(["REQ", subId, { authors: [pubkey], kinds: [0], limit: 1 }]));
        } catch {
          move();
        }
      });
      socket.addEventListener("message", (frame: Event) => {
        const text = messageText(frame);
        if (text === null) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        if (parsed[0] === "EVENT" && parsed[1] === subId) {
          const checked = parseSignedEvent(parsed[2], nowSeconds);
          if (checked.ok && checked.event.kind === 0 && checked.event.pubkey === pubkey) {
            candidates.push(checked.event);
          }
          return;
        }
        if (parsed[0] === "EOSE" && parsed[1] === subId) move();
      });
      socket.addEventListener("error", () => move());
      socket.addEventListener("close", () => move());
    };
    openNext();
  });
}

export async function lookupProfile(input: {
  pubkey: string;
  relays: string[];
  env: GatewayEnv;
  Socket: RelaySocketConstructor;
  now?: number;
  ctx?: { waitUntil(promise: Promise<unknown>): void };
}): Promise<{ event: NostrEvent; cache: "fresh" | "stale" | "miss" | "disabled" }> {
  const now = input.now ?? Date.now();
  const kv = input.env.PROFILES;
  const cached = kv ? await readCache(kv, input.pubkey, now) : null;
  if (cached && now - cached.storedAt <= FRESH_MS) {
    return { event: cached.event, cache: "fresh" };
  }
  const refresh = async (): Promise<NostrEvent | null> => {
    const event = await fetchKind0(
      input.pubkey,
      input.relays,
      5_000,
      input.Socket,
      Math.floor(now / 1000),
    );
    if (event && kv) await writeCache(kv, input.pubkey, event, Date.now());
    return event;
  };
  if (cached) {
    const work = refresh().catch(() => null);
    if (input.ctx) input.ctx.waitUntil(work);
    return { event: cached.event, cache: "stale" };
  }
  const event = await refresh();
  if (!event) throw new HttpError(404, "profile_not_found", "No signed kind 0 event was returned");
  return { event, cache: kv ? "miss" : "disabled" };
}
