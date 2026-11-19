# Nostr Publish Gateway

Nostr Publish Gateway lets applications publish already-signed Nostr events to multiple relays through an HTTP API instead of managing WebSocket connections directly.

It provides configurable retry strategies, relay delivery results, request validation, rate limiting, and operational safeguards.

It is a standalone Nostr developer utility maintained by NostrMash. It does not require NostrMash Core or SmartFlowSocial.

An HTTP 200 means the gateway accepted the request and finished the delivery attempt. It does not mean every relay stored the event. There is no durable queue. A relay acknowledgement is the confirmation.

## Runtime

Cloudflare Workers. Local development uses Wrangler. This project does not ship a Docker image.

- Node.js 22 or newer
- pnpm 12.21.0

## Install and test

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm exec wrangler dev
```

`pnpm test` includes a disposable WebSocket relay on `127.0.0.1`. It does not use a production key.

## Configure

Copy `.dev.vars.example` to `.dev.vars`. Wrangler does not commit that file.

Production publishing is closed until you set a token:

```bash
pnpm exec wrangler secret put API_TOKEN
```

`ENVIRONMENT` defaults to `production` in `wrangler.toml`. In production, `ALLOW_UNAUTHENTICATED_PUBLISH` and `ALLOW_PRIVATE_RELAYS` do nothing. Public publishing requires both `ENVIRONMENT=development` or `ENVIRONMENT=test` and `ALLOW_UNAUTHENTICATED_PUBLISH=true`, and it is still off when `API_TOKEN` is set.

Send the token as `Authorization: Bearer <token>` or as the `API-TOKEN` header. If both are present, both must match.

`ws://` and private-network relays are available only when `ENVIRONMENT` is `development` or `test` and `ALLOW_PRIVATE_RELAYS=true`. Link-local and metadata hosts stay blocked. The Worker cannot pin DNS, so a public name that later resolves to an internal address is a residual risk.

Profile caching is optional. Uncomment the `PROFILES` KV binding in `wrangler.toml` when you want it. A miss is fetched before the response. A fresh entry is ten minutes old or less. An entry older than ten minutes and younger than two hours is returned while a refresh runs. Older entries are fetched again.

## Deploy

CI does not deploy. The script name in `wrangler.toml` is `nostrmash-nostr-publish-gateway`. Confirm that name is free in your Cloudflare account before the first deploy. Do not point this repository at an existing SmartFlowSocial Worker.

```bash
pnpm exec wrangler deploy
```

Use a token stored as a secret. Do not put it in `wrangler.toml`.

## API

See [docs/API.md](docs/API.md).

## Security

See [SECURITY.md](SECURITY.md) and [docs/SOURCE_PROVENANCE.md](docs/SOURCE_PROVENANCE.md).

## License

[Unlicense](LICENSE) for the code in this repository. Third-party packages keep their own licenses. The provenance note explains what that dedication does not cover.
