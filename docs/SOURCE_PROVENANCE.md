# Source provenance

This note is a record of how this repository was written. It is not a legal opinion and it is not a statement that copyright risk has been cleared.

## Historical relationship

`smartflowsocial/smartflowsocial-publisher` is an older Cloudflare Worker. A review of that tree on 19 November 2026 found source that matches [getAlby/http-nostr-publisher](https://github.com/getAlby/http-nostr-publisher), which has no `LICENSE` file. GitHub reports that repository's license as null. The older Worker's Unlicense file does not grant rights in someone else's code.

This repository is a new Git history. It does not import the old `.git` directory and it does not copy that Worker's source files. The endpoint names `/publish`, `/batch`, `/profile`, and `/health`, and the optional `API-TOKEN` header, are a public HTTP contract for an already-signed event. The implementations behind them were written again for this repository.

## Reviewed files in the older Worker

These files were identified as the places to compare. The comparison used the older Worker source and the earlier written audit. It was not a line-by-line transcription into this repository.

| Older file                       | What the review found                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/index.ts`                   | A 404 body that repeats a distinctive sentence from the Alby Worker                                |
| `src/utils.ts`                   | npub, nsec, and note handling with a bech32 limit of 2000                                          |
| `src/transport/http/handlers.ts` | Profile cache timing of three hours, a charset content type, and a background refresh on that rule |
| `src/security/access.ts`         | Plain-text token failure response and HTTP 403                                                     |
| `src/core/RelayUrl.ts`           | A comment tying the normalizer to Alby's URL cleaner                                               |

The older publish engine is a later TypeScript design. It waits for NIP-01 `OK`. Alby's publisher returns success before a relay acknowledgement. That difference does not clear the other files.

## What this repository implements instead

| Behavior       | This repository                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown routes | JSON `not_found`. The Alby 404 sentence is not used                                                                                     |
| Authentication | JSON HTTP 401 `unauthorized`, or HTTP 503 when production has no token. The plain-text token failure body is not used                   |
| Pubkeys        | Hex or `npub` only, decoded with `@scure/base`. Secret-key strings are rejected. The 2000-character decoder budget is not used          |
| Event checks   | NIP-01 canonical id and BIP-340 verification through `@noble/curves` and `@noble/hashes`                                                |
| Relay URLs     | A host policy written for this gateway. Production rejects private, loopback, link-local, and metadata targets                          |
| Profile cache  | Ten minutes fresh, two hours maximum stale service, synchronous fetch on a miss, HTTP 200 or 404. Not the three-hour and seven-day rule |
| Delivery       | Per-relay `OK` classification, retries only for transport failure, in-isolate circuit breaker. No claim of a durable queue              |
| Streaming      | Not implemented. `?stream=true` is HTTP 400                                                                                             |

## Dependencies

| Package               | Role            | License |
| --------------------- | --------------- | ------- |
| `@noble/curves` 1.9.7 | BIP-340 Schnorr | MIT     |
| `@noble/hashes` 1.8.0 | SHA-256         | MIT     |
| `@scure/base` 1.2.5   | bech32 for npub | MIT     |

Development tools (TypeScript, Vitest, ESLint, Wrangler, `ws`) are not shipped as the Worker runtime library set. Their licenses stay with those packages.

## What this note does not claim

Rewriting a feature does not, by itself, prove that no protected expression remains. The author of this repository had read the older Worker's public API description and a list of the similarities above before writing the replacement. That is not a supervised clean-room process, and it is not permission from the Alby authors.

The repository stays private until a person responsible for publication decides that this record is enough, or until the Alby authors grant permission. Do not describe this file as legal clearance.

No copyright header from the Alby repository was copied here. None is invented.
