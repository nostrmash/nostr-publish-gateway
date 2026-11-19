const MAX_URL_LENGTH = 300;

export type RelayResult = { ok: true; url: string } | { ok: false; reason: string };

function blockedIpv4(host: string, allowPrivate: boolean): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = numbers[0] ?? 0;
  const b = numbers[1] ?? 0;
  if (a === 0 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (numbers[2] ?? 0) === 0) return true;
  if (a === 192 && b === 0 && (numbers[2] ?? 0) === 2) return true;
  if (a === 198 && b === 51 && (numbers[2] ?? 0) === 100) return true;
  if (a === 203 && b === 0 && (numbers[2] ?? 0) === 113) return true;
  const loopback = a === 127;
  const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (loopback || rfc1918) return !allowPrivate;
  return false;
}

function blockedIpv6(host: string, allowPrivate: boolean): boolean {
  const value = host.toLowerCase();
  if (value === "::" || value.startsWith("fe80:") || value.startsWith("ff")) return true;
  if (value === "::1") return !allowPrivate;
  if (value.startsWith("fc") || value.startsWith("fd")) return !allowPrivate;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) return blockedIpv4(mapped[1], allowPrivate);
  return false;
}

function blockedName(hostname: string, allowPrivate: boolean): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) return "relay host is empty";
  if (/^\d+$/.test(host)) return "numeric relay hosts are not allowed";
  if (
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host === "instance-data" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".localdomain")
  ) {
    return "relay host is not allowed";
  }
  if (host.includes(":"))
    return blockedIpv6(host, allowPrivate) ? "relay address is not allowed" : null;
  if (host.includes(".")) {
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    if (ipv4 && blockedIpv4(host, allowPrivate)) return "relay address is not allowed";
  }
  if ((host === "localhost" || host.endsWith(".localhost")) && !allowPrivate) {
    return "relay address is not allowed";
  }
  return null;
}

export function normalizeRelayUrl(input: string, allowPrivate: boolean): RelayResult {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "relay URL length is invalid" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "relay URL is invalid" };
  }
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "relay URL cannot contain credentials" };
  if (url.search !== "" || url.hash !== "")
    return { ok: false, reason: "relay URL cannot contain a query or fragment" };
  const privateHostError = blockedName(url.hostname, allowPrivate);
  const privateHost = privateHostError === null && isOperatorHost(url.hostname, allowPrivate);
  if (url.protocol === "ws:") {
    if (!allowPrivate || !privateHost)
      return { ok: false, reason: "ws:// relays are limited to a local test network" };
  } else if (url.protocol !== "wss:") {
    return { ok: false, reason: "relay URL must use wss://" };
  }
  if (privateHostError) return { ok: false, reason: privateHostError };
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const port = url.port === "" ? "" : `:${url.port}`;
  const hostname = url.hostname.toLowerCase();
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return { ok: true, url: `${url.protocol}//${host}${port}${path}` };
}

function isOperatorHost(hostname: string, allowPrivate: boolean): boolean {
  if (!allowPrivate) return false;
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (host.includes(":")) return !blockedIpv6(host, true);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !blockedIpv4(host, true);
  return false;
}

export function normalizeRelayList(
  values: unknown,
  allowPrivate: boolean,
  maxRelays: number,
): { ok: true; urls: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(values) || values.length === 0)
    return { ok: false, reason: "relays must be a non-empty array" };
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return { ok: false, reason: "each relay must be a string" };
    const normalized = normalizeRelayUrl(value, allowPrivate);
    if (!normalized.ok) return normalized;
    if (seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    urls.push(normalized.url);
    if (urls.length > maxRelays)
      return { ok: false, reason: `at most ${maxRelays} relays are accepted` };
  }
  if (urls.length === 0) return { ok: false, reason: "relays must be a non-empty array" };
  return { ok: true, urls };
}
