import {
  applyCors,
  assertHealthProbe,
  assertPublishAuth,
  authMode,
  privateRelaysAllowed,
  rateLimitKey,
  runtimeName,
  type GatewayEnv,
} from "./auth";
import {
  HttpError,
  jsonResponse,
  readLimitedBody,
  requestId,
  requireJsonContentType,
} from "./http";
import { parseSignedEvent, type NostrEvent } from "./nostr/event";
import { parsePubkey } from "./nostr/pubkey";
import { lookupProfile } from "./profile";
import { normalizeRelayList } from "./relay/address";
import { createCircuitBreaker, createRateLimiter, positiveInt } from "./relay/circuit";
import {
  POLICIES,
  probeRelay,
  publishEvent,
  type PublishPolicy,
  type RelaySocketConstructor,
} from "./relay/publish";

const PUBLISH_BODY_LIMIT = 1_000_000;
const BATCH_BODY_LIMIT = 1_500_000;
const PROFILE_BODY_LIMIT = 64_000;
const MAX_RELAYS = 12;
const MAX_BATCH = 20;
const MAX_PROFILE_RELAYS = 4;

const breakers = createCircuitBreaker();
const limiter = createRateLimiter();
const PROBE_CONCURRENCY = 4;

interface ProbeCache {
  key: string;
  expiresAt: number;
  status: number;
  body: Record<string, unknown>;
}

let probeCache: ProbeCache | null = null;
let probeInflight: { key: string; promise: Promise<ProbeCache> } | null = null;
let probeHits: number[] = [];

export interface HandlerDependencies {
  webSocket?: RelaySocketConstructor;
  now?: () => number;
  breaker?: ReturnType<typeof createCircuitBreaker>;
  rateLimiter?: ReturnType<typeof createRateLimiter>;
}

export function resetRuntimeState(): void {
  breakers.reset();
  limiter.reset();
  probeCache = null;
  probeInflight = null;
  probeHits = [];
}

function routePath(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function policyFrom(request: Request, env: GatewayEnv): PublishPolicy {
  const name = new URL(request.url).searchParams.get("policy") ?? "default";
  if (name !== "default" && name !== "conservative" && name !== "aggressive") {
    throw new HttpError(
      400,
      "invalid_policy",
      "policy must be default, conservative, or aggressive",
    );
  }
  if (new URL(request.url).searchParams.get("stream") === "true") {
    throw new HttpError(400, "unsupported_feature", "Streaming responses are not implemented");
  }
  const base = POLICIES[name];
  if (runtimeName(env) === "production" || runtimeName(env) === "other") return base;
  return {
    ...base,
    attemptTimeoutMs: positiveInt(
      env.PUBLISH_ATTEMPT_TIMEOUT_MS,
      base.attemptTimeoutMs,
      20,
      30_000,
    ),
    overallTimeoutMs: positiveInt(
      env.PUBLISH_OVERALL_TIMEOUT_MS,
      base.overallTimeoutMs,
      20,
      30_000,
    ),
  };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder().decode(bytes);
    if (text.trim() === "") throw new Error("empty");
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function relaysFrom(value: unknown, env: GatewayEnv, max: number): string[] {
  const normalized = normalizeRelayList(value, privateRelaysAllowed(env), max);
  if (!normalized.ok) throw new HttpError(400, "invalid_relay", normalized.reason);
  return normalized.urls;
}

function eventFrom(value: unknown, now: number): NostrEvent {
  const parsed = parseSignedEvent(value, now);
  if (!parsed.ok) throw new HttpError(400, "invalid_event", parsed.reason);
  return parsed.event;
}

function enforceRateLimit(request: Request, env: GatewayEnv, deps: HandlerDependencies): void {
  const limit = positiveInt(env.RATE_LIMIT_REQUESTS, 60, 1, 10_000);
  const windowMs = positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000);
  const gate = deps.rateLimiter ?? limiter;
  const decision = gate.take(rateLimitKey(request, env), limit, windowMs);
  if (!decision.ok) {
    throw new HttpError(
      429,
      "rate_limited",
      `Rate limit exceeded. Retry after ${decision.retryAfterSeconds} seconds`,
      decision.retryAfterSeconds,
    );
  }
}

function probeSetting(value: string | undefined, fallback: number, max: number): number {
  const raw = value?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Number(raw));
}

function requiredReachable(total: number, env: GatewayEnv): number | null {
  const count = env.PROBE_MIN_REACHABLE?.trim() ?? "";
  if (count !== "") {
    if (!/^[1-9]\d*$/.test(count)) return null;
    return Math.min(total, Number(count));
  }
  const percent = env.PROBE_MIN_PERCENT?.trim() ?? "";
  if (percent === "") return total;
  if (!/^(100|[1-9][0-9]?)$/.test(percent)) return null;
  return Math.max(1, Math.ceil((total * Number(percent)) / 100));
}

function allowProbe(now: number, env: GatewayEnv): boolean {
  const limit = Math.max(1, probeSetting(env.HEALTH_PROBE_LIMIT, 30, 1_000));
  const windowMs = Math.max(1_000, probeSetting(env.HEALTH_PROBE_WINDOW_MS, 60_000, 3_600_000));
  probeHits = probeHits.filter((at) => now - at < windowMs);
  if (probeHits.length >= limit) return false;
  probeHits.push(now);
  return true;
}

async function probeLimited(
  relays: string[],
  timeoutMs: number,
  Socket: RelaySocketConstructor,
): Promise<boolean[]> {
  const results = new Array<boolean>(relays.length);
  let next = 0;
  const worker = async () => {
    while (next < relays.length) {
      const index = next;
      next += 1;
      const relay = relays[index];
      results[index] = relay ? await probeRelay(relay, timeoutMs, Socket) : false;
    }
  };
  const workers = Math.min(PROBE_CONCURRENCY, relays.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function handleDeepHealth(
  request: Request,
  env: GatewayEnv,
  deps: HandlerDependencies,
  trace: string,
): Promise<Response> {
  await assertHealthProbe(request, env);
  const configured = (env.PROBE_RELAYS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (configured.length === 0) {
    return jsonResponse(503, { status: "misconfigured", code: "probe_relays_missing" }, trace);
  }
  let relays: string[];
  try {
    relays = relaysFrom(configured, env, MAX_RELAYS);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(503, { status: "misconfigured", code: error.code }, trace);
    }
    throw error;
  }
  const required = requiredReachable(relays.length, env);
  if (required === null) {
    return jsonResponse(503, { status: "misconfigured", code: "probe_threshold_invalid" }, trace);
  }
  const now = deps.now ?? Date.now;
  const key = `${relays.join(",")}|${required}`;
  const ttl = probeSetting(env.HEALTH_PROBE_CACHE_MS, 15_000, 60_000);
  const clock = now();
  if (ttl > 0 && probeCache && probeCache.key === key && probeCache.expiresAt > clock) {
    return jsonResponse(probeCache.status, { ...probeCache.body, cached: true }, trace);
  }
  if (!allowProbe(clock, env)) {
    return jsonResponse(429, { status: "down", code: "rate_limited" }, trace);
  }
  if (probeInflight?.key === key) {
    const shared = await probeInflight.promise;
    return jsonResponse(shared.status, { ...shared.body, cached: true }, trace);
  }
  const timeoutMs = Math.min(positiveInt(env.PUBLISH_ATTEMPT_TIMEOUT_MS, 3_000, 200, 8_000), 3_000);
  const promise = (async (): Promise<ProbeCache> => {
    const checks = await probeLimited(relays, timeoutMs, deps.webSocket ?? WebSocket);
    const reachable = checks.filter(Boolean).length;
    const statusName = reachable === 0 ? "down" : reachable >= required ? "healthy" : "degraded";
    const status = statusName === "down" ? 503 : 200;
    const body = { status: statusName, checked: checks.length, reachable, required };
    return { key, expiresAt: clock + ttl, status, body };
  })();
  probeInflight = { key, promise };
  try {
    const result = await promise;
    if (ttl > 0) probeCache = result;
    return jsonResponse(result.status, { ...result.body, cached: false }, trace);
  } finally {
    if (probeInflight?.promise === promise) probeInflight = null;
  }
}

async function publishOne(
  request: Request,
  env: GatewayEnv,
  deps: HandlerDependencies,
  trace: string,
  relays: string[],
  event: NostrEvent,
): Promise<Response> {
  const policy = policyFrom(request, env);
  const result = await publishEvent({
    event,
    relays,
    policy,
    signal: request.signal,
    breaker: deps.breaker ?? breakers,
    Socket: deps.webSocket ?? WebSocket,
  });
  console.log(
    JSON.stringify({
      component: "nostr-publish-gateway",
      trace,
      route: "publish",
      eventId: event.id,
      status: result.status,
      relays: result.results.map((item) => ({ relay: item.relay, outcome: item.outcome })),
    }),
  );
  return jsonResponse(200, { status: result.status, results: result.results }, trace);
}

async function handlePublish(
  request: Request,
  env: GatewayEnv,
  deps: HandlerDependencies,
  trace: string,
): Promise<Response> {
  requireJsonContentType(request);
  const body = asRecord(parseJson(await readLimitedBody(request, PUBLISH_BODY_LIMIT)));
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const relays = relaysFrom(body.relays, env, MAX_RELAYS);
  const event = eventFrom(body.event, now);
  return publishOne(request, env, deps, trace, relays, event);
}

async function handleBatch(
  request: Request,
  env: GatewayEnv,
  deps: HandlerDependencies,
  trace: string,
): Promise<Response> {
  requireJsonContentType(request);
  const body = asRecord(parseJson(await readLimitedBody(request, BATCH_BODY_LIMIT)));
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const relays = relaysFrom(body.relays, env, MAX_RELAYS);
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_BATCH) {
    throw new HttpError(400, "invalid_request", `events must contain 1 to ${MAX_BATCH} events`);
  }
  const events = body.events.map((value) => eventFrom(value, now));
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id))
      throw new HttpError(400, "invalid_request", "batch contains a duplicate event id");
    ids.add(event.id);
  }
  const policy = policyFrom(request, env);
  const published = [];
  for (const event of events) {
    if (request.signal.aborted)
      throw new HttpError(408, "client_cancelled", "The client cancelled the request");
    const result = await publishEvent({
      event,
      relays,
      policy,
      signal: request.signal,
      breaker: deps.breaker ?? breakers,
      Socket: deps.webSocket ?? WebSocket,
    });
    published.push({ id: event.id, status: result.status, results: result.results });
  }
  const accepted = published.filter(
    (item) => item.status === "accepted" || item.status === "partial",
  ).length;
  return jsonResponse(
    200,
    {
      status: accepted === published.length ? "accepted" : accepted > 0 ? "partial" : "failed",
      events: published,
    },
    trace,
  );
}

async function handleProfile(
  request: Request,
  env: GatewayEnv,
  deps: HandlerDependencies,
  trace: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  requireJsonContentType(request);
  const body = asRecord(parseJson(await readLimitedBody(request, PROFILE_BODY_LIMIT)));
  if (typeof body.pubkey !== "string")
    throw new HttpError(400, "invalid_request", "pubkey is required");
  const pubkey = parsePubkey(body.pubkey);
  if (!pubkey.ok) throw new HttpError(400, "invalid_request", pubkey.reason);
  const configured = (env.DEFAULT_PROFILE_RELAYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const relayInput = body.relays === undefined ? configured : body.relays;
  const relays = relaysFrom(relayInput, env, MAX_PROFILE_RELAYS);
  const found = await lookupProfile({
    pubkey: pubkey.pubkey,
    relays,
    env,
    Socket: deps.webSocket ?? WebSocket,
    now: deps.now?.(),
    ctx,
  });
  return jsonResponse(200, { cache: found.cache, profile: found.event }, trace);
}

export async function handleFetch(
  request: Request,
  env: GatewayEnv,
  ctx?: ExecutionContext,
  deps: HandlerDependencies = {},
): Promise<Response> {
  const trace = requestId(request);
  const path = routePath(request);
  try {
    if (request.method === "OPTIONS") {
      if (env.CORS_ENABLED !== "true")
        return jsonResponse(404, { error: "not_found", code: "not_found" }, trace);
      return applyCors(
        request,
        new Response(null, { status: 204, headers: { "x-request-id": trace } }),
        env,
      );
    }
    if (request.method === "GET" && path === "/health") {
      const mode = authMode(env);
      return applyCors(
        request,
        jsonResponse(200, { status: "ok", auth: mode, environment: runtimeName(env) }, trace),
        env,
      );
    }
    if (request.method === "GET" && path === "/health/deep") {
      return applyCors(request, await handleDeepHealth(request, env, deps, trace), env);
    }
    const publishing =
      request.method === "POST" &&
      (path === "/" || path === "/publish" || path === "/batch" || path === "/profile");
    if (!publishing) return jsonResponse(404, { error: "not_found", code: "not_found" }, trace);
    assertPublishAuth(request, env);
    enforceRateLimit(request, env, deps);
    if (path === "/" || path === "/publish")
      return applyCors(request, await handlePublish(request, env, deps, trace), env);
    if (path === "/batch")
      return applyCors(request, await handleBatch(request, env, deps, trace), env);
    return applyCors(request, await handleProfile(request, env, deps, trace, ctx), env);
  } catch (error) {
    if (error instanceof HttpError) {
      const headers =
        error.retryAfterSeconds === undefined
          ? undefined
          : { "retry-after": String(error.retryAfterSeconds) };
      return applyCors(
        request,
        jsonResponse(error.status, { error: error.message, code: error.code }, trace, headers),
        env,
      );
    }
    console.log(
      JSON.stringify({
        component: "nostr-publish-gateway",
        trace,
        outcome: "internal_error",
      }),
    );
    return jsonResponse(500, { error: "internal error", code: "internal_error" }, trace);
  }
}

const handler: ExportedHandler<GatewayEnv> = {
  fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
};

export default handler;
