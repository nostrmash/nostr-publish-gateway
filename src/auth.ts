import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";

import { HttpError } from "./http";

export interface GatewayEnv {
  API_TOKEN?: string;
  ENVIRONMENT?: string;
  ALLOW_UNAUTHENTICATED_PUBLISH?: string;
  ALLOW_PRIVATE_RELAYS?: string;
  CORS_ENABLED?: string;
  CORS_ORIGINS?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  DEFAULT_PROFILE_RELAYS?: string;
  PUBLISH_ATTEMPT_TIMEOUT_MS?: string;
  PUBLISH_OVERALL_TIMEOUT_MS?: string;
  PROFILES?: ProfileKv;
}

export interface ProfileKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type AuthMode = "token" | "open" | "misconfigured";

export function runtimeName(env: GatewayEnv): "production" | "development" | "test" | "other" {
  const value = env.ENVIRONMENT?.trim().toLowerCase() ?? "";
  if (value === "development" || value === "test") return value;
  if (value === "" || value === "production") return "production";
  return "other";
}

function localRuntime(env: GatewayEnv): boolean {
  const name = runtimeName(env);
  return name === "development" || name === "test";
}

export function authMode(env: GatewayEnv): AuthMode {
  if ((env.API_TOKEN ?? "").length > 0) return "token";
  if (localRuntime(env) && env.ALLOW_UNAUTHENTICATED_PUBLISH === "true") return "open";
  return "misconfigured";
}

export function privateRelaysAllowed(env: GatewayEnv): boolean {
  return localRuntime(env) && env.ALLOW_PRIVATE_RELAYS === "true";
}

function tokenMatches(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function assertPublishAuth(request: Request, env: GatewayEnv): void {
  const mode = authMode(env);
  if (mode === "misconfigured") {
    throw new HttpError(
      503,
      "publisher_auth_not_configured",
      "Set API_TOKEN before exposing publish routes. Public mode is development and test only.",
    );
  }
  if (mode === "open") return;
  const expected = env.API_TOKEN ?? "";
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const headerToken = request.headers.get("api-token")?.trim() ?? "";
  const presented = [bearer, headerToken].filter((value) => value.length > 0);
  if (presented.length === 0 || presented.some((value) => !tokenMatches(value, expected))) {
    throw new HttpError(401, "unauthorized", "Authentication failed");
  }
}

export function rateLimitKey(request: Request, env: GatewayEnv): string {
  if (authMode(env) === "token") {
    const token = env.API_TOKEN ?? "";
    return `token:${bytesToHex(sha256(new TextEncoder().encode(token))).slice(0, 16)}`;
  }
  const ip =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous";
  return `ip:${ip.slice(0, 80)}`;
}

export function applyCors(request: Request, response: Response, env: GatewayEnv): Response {
  if (env.CORS_ENABLED !== "true") return response;
  const origin = request.headers.get("origin")?.trim() ?? "";
  const allowed = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (origin.length === 0 || !allowed.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, authorization, api-token, x-request-id",
  );
  headers.set("access-control-expose-headers", "x-request-id");
  headers.set("access-control-max-age", "600");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
