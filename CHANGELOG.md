# Changelog

## Unreleased

- `GET /health/deep` opens relays listed in `PROBE_RELAYS` and does not publish an event. `GET /health` still does not contact relays.

## 0.1.0

First implementation. HTTP publishing to relays, batch publishing, optional kind 0 lookup, per-relay acknowledgements, retries, and an in-isolate circuit breaker.
