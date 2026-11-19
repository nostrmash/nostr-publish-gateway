# API

All responses are JSON. `X-Request-ID` is echoed when the request header matches `[A-Za-z0-9._:-]{1,80}`, otherwise the gateway generates one.

## Authentication

When `API_TOKEN` is set, send either header:

```text
Authorization: Bearer <token>
API-TOKEN: <token>
```

A missing or wrong token is HTTP 401:

```json
{ "error": "Authentication failed", "code": "unauthorized" }
```

If `API_TOKEN` is unset and public mode is not enabled, publish routes return HTTP 503 `publisher_auth_not_configured`. `GET /health` stays available and reports `"auth": "misconfigured"`.

## GET /health

Does not contact relays.

```json
{ "status": "ok", "auth": "token", "environment": "production" }
```

`auth` is `token`, `open`, or `misconfigured`.

## POST /publish and POST /

Body limit 1,000,000 bytes. At most 12 relays after normalization.

```json
{
  "relays": ["wss://relay.example/"],
  "event": {
    "id": "64 lowercase hex characters",
    "pubkey": "64 lowercase hex characters",
    "created_at": 1234567890,
    "kind": 1,
    "tags": [],
    "content": "hello",
    "sig": "128 lowercase hex characters"
  }
}
```

Query `policy` is `default`, `conservative`, or `aggressive`.

| Policy       | Attempt | Overall budget | Retries | Concurrency |
| ------------ | ------: | -------------: | ------: | ----------: |
| default      |      8s |            20s |       1 |           6 |
| conservative |     12s |            25s |       2 |           4 |
| aggressive   |      4s |            12s |       0 |           8 |

`?stream=true` is HTTP 400. Results are not streamed.

HTTP 200:

```json
{
  "status": "partial",
  "results": [
    { "relay": "wss://relay.example", "outcome": "accepted", "accepted": true, "latencyMs": 40 },
    {
      "relay": "wss://other.example",
      "outcome": "rejected",
      "accepted": false,
      "latencyMs": 30,
      "message": "blocked"
    }
  ]
}
```

`status` is `accepted` when every relay result has `accepted: true`, `partial` when at least one did, `rejected` when every relay refused the event, and `failed` otherwise.

`outcome` is `accepted`, `duplicate`, `rejected`, `timeout`, `connection_failed`, `circuit_open`, or `cancelled`. `duplicate` is a NIP-01 `OK false` whose message contains "duplicate". It counts as accepted because the relay already has the event. Other negative acknowledgements are not retried. Timeouts and connection failures are retried within the budget. Four consecutive transport failures open that relay for 20 seconds inside the current isolate.

The circuit breaker and the rate limit live in the isolate. They reset when the isolate goes away. The default rate limit is 60 requests per 60 seconds.

## POST /batch

Body limit 1,500,000 bytes. 1 to 20 events. The same relay rules apply. Every event is checked before the first relay connection. One invalid event rejects the batch. Duplicate ids in the batch are rejected. Events are published one after another and share the policy budget of each call.

HTTP 200:

```json
{
  "status": "partial",
  "events": [{ "id": "event id", "status": "accepted", "results": [] }]
}
```

## POST /profile

```json
{ "pubkey": "hex or npub", "relays": ["wss://profiles.example/"] }
```

`nsec` is rejected. At most four relays. If `relays` is omitted, `DEFAULT_PROFILE_RELAYS` is used. The gateway requests kind 0, checks the signature, and returns the newest match.

```json
{ "cache": "miss", "profile": { "kind": 0 } }
```

`cache` is `fresh`, `stale`, `miss`, or `disabled`. HTTP 404 `profile_not_found` means no signed kind 0 event came back. That is not cached as a negative entry.

## Other errors

| HTTP | code                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 400  | `invalid_json`, `invalid_request`, `invalid_event`, `invalid_relay`, `invalid_policy`, `unsupported_feature` |
| 401  | `unauthorized`                                                                                               |
| 408  | `client_cancelled`                                                                                           |
| 413  | `body_too_large`                                                                                             |
| 415  | `unsupported_media_type`                                                                                     |
| 429  | `rate_limited`                                                                                               |
| 503  | `publisher_auth_not_configured`                                                                              |
