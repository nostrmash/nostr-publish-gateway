export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function requestId(request: Request): string {
  const raw = request.headers.get("x-request-id")?.trim() ?? "";
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

export function jsonResponse(
  status: number,
  body: unknown,
  requestIdValue: string,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("x-request-id", requestIdValue);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    const size = Number(declared.trim());
    if (Number.isSafeInteger(size) && size > maxBytes) {
      throw new HttpError(413, "body_too_large", "Request body is too large");
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large", "Request body is too large");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function requireJsonContentType(request: Request): void {
  const header = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (header !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
}
