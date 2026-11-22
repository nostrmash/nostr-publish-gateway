# Security

Report vulnerabilities privately through GitHub security advisories for this repository. Do not include tokens, event contents, or relay credentials in a public issue.

## Boundaries

- Publish routes require `API_TOKEN` unless public mode is explicitly enabled outside production.
- A missing production token fails closed with HTTP 503. It does not publish.
- Event ids and Schnorr signatures are checked before any relay is contacted.
- Relay URLs are restricted to `wss://`, with `ws://` only for an operator network in development or test.
- Credentials, queries, fragments, loopback, private, link-local, and metadata hosts are rejected in production.
- Request bodies are capped. The rate limit is per isolate, not a global quota.
- Logs include the request id, event id, relay, and outcome. They do not include the token, the signature, or event content.
- CORS is off until `CORS_ENABLED=true` and the request origin is listed in `CORS_ORIGINS`.
- `/health` does not open relay connections.
- `/health/deep` requires `HEALTH_PROBE_TOKEN` in production, opens only the relays listed in `PROBE_RELAYS`, and sends no event. It does not accept `API_TOKEN`. Leave `PROBE_RELAYS` unset to keep the probe disabled. The limit is per isolate.

HTTP 200 is not a delivery guarantee. A result of `accepted` means that relay returned NIP-01 `OK true`, or `OK false` with a duplicate message. `rejected` means the relay refused the event. `timeout` and `connection_failed` mean there was no acknowledgement.

The gateway does not store a durable replay log. Relays deduplicate by event id.

DNS rebinding of a public hostname is not fully prevented inside Workers. Do not treat the host check as a private-network firewall.
