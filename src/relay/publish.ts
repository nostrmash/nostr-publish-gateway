import type { NostrEvent } from "../nostr/event";
import type { CircuitBreaker } from "./circuit";

export interface PublishPolicy {
  attemptTimeoutMs: number;
  overallTimeoutMs: number;
  retries: number;
  concurrency: number;
}

export type RelayOutcomeName =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "timeout"
  | "connection_failed"
  | "circuit_open"
  | "cancelled";

export interface RelayOutcome {
  relay: string;
  outcome: RelayOutcomeName;
  accepted: boolean;
  latencyMs: number;
  message?: string;
}

export type DeliveryStatus = "accepted" | "partial" | "rejected" | "failed";

export interface RelaySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export type RelaySocketConstructor = new (url: string) => RelaySocket;

export const POLICIES: Record<"default" | "conservative" | "aggressive", PublishPolicy> = {
  default: { attemptTimeoutMs: 8_000, overallTimeoutMs: 20_000, retries: 1, concurrency: 6 },
  conservative: { attemptTimeoutMs: 12_000, overallTimeoutMs: 25_000, retries: 2, concurrency: 4 },
  aggressive: { attemptTimeoutMs: 4_000, overallTimeoutMs: 12_000, retries: 0, concurrency: 8 },
};

function messageText(event: Event): string | null {
  if (!("data" in event)) return null;
  const data = event.data;
  return typeof data === "string" ? data : null;
}

function classifyOk(
  parsed: unknown,
  eventId: string,
): { kind: "accepted" | "duplicate" | "rejected"; message?: string } | null {
  if (!Array.isArray(parsed) || parsed[0] !== "OK" || parsed[1] !== eventId) return null;
  const message = typeof parsed[3] === "string" ? parsed[3].slice(0, 300) : undefined;
  if (parsed[2] === true) return { kind: "accepted", message };
  if (parsed[2] === false) {
    if (message !== undefined && /duplicate/i.test(message)) return { kind: "duplicate", message };
    return { kind: "rejected", message };
  }
  return null;
}

function abortName(signal: AbortSignal): "timeout" | "cancelled" {
  const reason: unknown = signal.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  ) {
    return "timeout";
  }
  return "cancelled";
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function publishOnce(
  relay: string,
  event: NostrEvent,
  timeoutMs: number,
  signal: AbortSignal,
  Socket: RelaySocketConstructor,
): Promise<RelayOutcome> {
  const started = Date.now();
  let socket: RelaySocket;
  try {
    socket = new Socket(relay);
  } catch {
    return Promise.resolve({
      relay,
      outcome: "connection_failed",
      accepted: false,
      latencyMs: Date.now() - started,
      message: "socket setup failed",
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RelayOutcomeName, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({
        relay,
        outcome,
        accepted: outcome === "accepted" || outcome === "duplicate",
        latencyMs: Date.now() - started,
        message,
      });
    };
    const onAbort = () => finish(abortName(signal));
    const onError = () => finish("connection_failed", "socket error");
    const onClose = () => finish("connection_failed", "socket closed");
    const onMessage = (frame: Event) => {
      const text = messageText(frame);
      if (text === null) {
        finish("connection_failed", "non-text socket frame");
        return;
      }
      try {
        const verdict = classifyOk(JSON.parse(text) as unknown, event.id);
        if (verdict) finish(verdict.kind, verdict.message);
      } catch {
        finish("connection_failed", "relay sent malformed json");
      }
    };
    const onOpen = () => {
      try {
        socket.send(JSON.stringify(["EVENT", event]));
      } catch {
        finish("connection_failed", "socket send failed");
      }
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (signal.aborted) {
      finish(abortName(signal));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function publishRelay(
  relay: string,
  event: NostrEvent,
  policy: PublishPolicy,
  signal: AbortSignal,
  breaker: CircuitBreaker,
  Socket: RelaySocketConstructor,
): Promise<RelayOutcome> {
  let last: RelayOutcome = {
    relay,
    outcome: "connection_failed",
    accepted: false,
    latencyMs: 0,
  };
  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    if (signal.aborted) {
      return { relay, outcome: abortName(signal), accepted: false, latencyMs: 0 };
    }
    if (!breaker.allow(relay)) {
      return {
        relay,
        outcome: "circuit_open",
        accepted: false,
        latencyMs: 0,
        message: "circuit open",
      };
    }
    const outcome = await publishOnce(relay, event, policy.attemptTimeoutMs, signal, Socket);
    if (outcome.accepted) {
      breaker.succeed(relay);
      return outcome;
    }
    if (outcome.outcome === "rejected" || outcome.outcome === "cancelled") return outcome;
    if (outcome.outcome === "timeout" || outcome.outcome === "connection_failed")
      breaker.fail(relay);
    last = outcome;
    if (attempt < policy.retries) await delay(150 * 3 ** attempt, signal);
  }
  return last;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function summarize(results: RelayOutcome[]): DeliveryStatus {
  if (results.length === 0) return "failed";
  const accepted = results.some((result) => result.accepted);
  const failed = results.some((result) => !result.accepted);
  if (accepted && !failed) return "accepted";
  if (accepted && failed) return "partial";
  if (results.every((result) => result.outcome === "rejected")) return "rejected";
  return "failed";
}

export async function publishEvent(input: {
  event: NostrEvent;
  relays: string[];
  policy: PublishPolicy;
  signal: AbortSignal;
  breaker: CircuitBreaker;
  Socket: RelaySocketConstructor;
}): Promise<{ status: DeliveryStatus; results: RelayOutcome[] }> {
  const budget = AbortSignal.timeout(input.policy.overallTimeoutMs);
  const signal = AbortSignal.any([input.signal, budget]);
  const results = await mapPool(input.relays, input.policy.concurrency, (relay) =>
    publishRelay(relay, input.event, input.policy, signal, input.breaker, input.Socket),
  );
  return { status: summarize(results), results };
}
