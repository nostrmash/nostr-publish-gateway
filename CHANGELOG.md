# Changelog

## Unreleased

- `GET /health/deep` opens relays listed in `PROBE_RELAYS` and does not publish an event. `GET /health` still does not contact relays.
- `GET /health/deep` requires `HEALTH_PROBE_TOKEN` in production and reports partial relay availability as `degraded`.

## 0.1.0

First implementation. HTTP publishing to relays, batch publishing, optional kind 0 lookup, per-relay acknowledgements, retries, and an in-isolate circuit breaker.
