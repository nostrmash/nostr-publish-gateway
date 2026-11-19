interface BreakerState {
  failures: number;
  openUntil: number;
  probe: boolean;
}

export interface CircuitBreaker {
  allow(key: string): boolean;
  succeed(key: string): void;
  fail(key: string): void;
  reset(): void;
}

/**
 * Per-isolate breaker. Four transport failures open it for 20 seconds.
 * One trial is allowed after that. A rejected event does not count.
 */
export function createCircuitBreaker(options?: {
  threshold?: number;
  openMs?: number;
  now?: () => number;
}): CircuitBreaker {
  const threshold = options?.threshold ?? 4;
  const openMs = options?.openMs ?? 20_000;
  const now = options?.now ?? Date.now;
  const states = new Map<string, BreakerState>();

  return {
    allow(key: string): boolean {
      const state = states.get(key);
      if (!state) return true;
      if (state.openUntil > now()) return false;
      if (state.openUntil !== 0 && !state.probe) {
        state.probe = true;
        return true;
      }
      if (state.probe) return false;
      return true;
    },
    succeed(key: string): void {
      states.delete(key);
    },
    fail(key: string): void {
      const state = states.get(key) ?? { failures: 0, openUntil: 0, probe: false };
      state.probe = false;
      state.failures += 1;
      if (state.failures >= threshold) {
        state.openUntil = now() + openMs;
        state.failures = 0;
      }
      states.set(key, state);
    },
    reset(): void {
      states.clear();
    },
  };
}

export interface RateLimiter {
  take(
    key: string,
    limit?: number,
    windowMs?: number,
  ): { ok: true } | { ok: false; retryAfterSeconds: number };
  reset(): void;
}

export function createRateLimiter(options?: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter {
  const limit = options?.limit ?? 60;
  const windowMs = options?.windowMs ?? 60_000;
  const now = options?.now ?? Date.now;
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    take(key: string, nextLimit = limit, nextWindow = windowMs) {
      const time = now();
      const bucket = buckets.get(key);
      if (!bucket || time - bucket.start >= nextWindow) {
        buckets.set(key, { start: time, count: 1 });
        return { ok: true as const };
      }
      if (bucket.count >= nextLimit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((nextWindow - (time - bucket.start)) / 1000),
        );
        return { ok: false as const, retryAfterSeconds };
      }
      bucket.count += 1;
      return { ok: true as const };
    },
    reset(): void {
      buckets.clear();
    },
  };
}

export function positiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
