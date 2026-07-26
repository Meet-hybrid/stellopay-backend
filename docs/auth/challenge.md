# Challenge — nonce typed-data builder

Source: [`src/auth/challenge.ts`](../../src/auth/challenge.ts)

## Overview

`challenge.ts` owns one job: constructing the SNIP-12 typed-data object that a
Starknet wallet (ArgentX, Braavos, Ready) signs to prove address ownership. It
is called by two routes in `src/routes/auth.ts`:

| Route | Purpose |
|---|---|
| `POST /auth/challenge` | Issue a nonce; return typed data for the wallet to sign |
| `POST /auth/verify` | Rebuild typed data to verify the submitted signature |

---

## Public API

### `buildTypedChallenge(address, chainId, nonce)`

Returns a SNIP-12 `TypedData` object.

```ts
import { buildTypedChallenge } from "./auth/challenge.js";

const typedData = buildTypedChallenge(address, chainId, nonce);
// → pass to provider.verifyMessageInStarknet(typedData, signature, address)
```

**Parameters**

| Name | Type | Description |
|---|---|---|
| `address` | `string` | Wallet address that will sign the challenge |
| `chainId` | `string` | Encoded felt from the Starknet RPC (e.g. result of `encodeShortString("SN_SEPOLIA")`) |
| `nonce` | `string` | Unique per-challenge nonce from `createChallenge` |

**Returns** — a `TypedData` object with:
- `types` — shared module-level constant (never re-allocated per call)
- `primaryType: "Challenge"`
- `domain` — `StelloPay / v1 / <chainId label> / revision 1`
- `message` — `{ action: "LOGIN", wallet: address, nonce }`

---

### `getChainIdLabel(chainId)`

Decodes an encoded chain-ID felt to its human-readable label, with memoisation.

```ts
getChainIdLabel(encodeShortString("SN_SEPOLIA")) // → "SN_SEPOLIA"
getChainIdLabel(encodeShortString("SN_MAIN"))    // → "SN_MAIN"
```

The result is cached in a module-level `Map` keyed by the encoded felt. Because
the chain ID is fixed for the lifetime of the process (sourced from
`getCachedNetworkInfo`), the decode only ever runs once per unique felt value.

---

### `clearChainIdCache()`

Clears the chain-ID decode cache. **Test use only** — production code must not
call this.

---

## Performance design

Two sources of repeated work existed before this change:

### 1. `shortString.decodeShortString` on every request

`buildTypedChallenge` was calling `decodeShortString(chainId)` on every
`/auth/challenge` and `/auth/verify` request. The chain ID felt is constant for
the process lifetime; the decode result never varies. It is now cached in
`chainIdCache` via `getChainIdLabel` so the decode runs at most once per unique
felt.

### 2. `CHALLENGE_TYPES` re-allocated on every call

The `types` object (SNIP-12 field descriptors for `StarknetDomain` and
`Challenge`) was an object literal inside the function body, causing a fresh
allocation on every call even though the value never changes. It is now a
module-level constant. The test `"shares the same types object reference across
calls"` verifies referential equality (`toBe`) to guard against regression.

### What changes per call

Only two fields actually vary between invocations:
- `message.wallet` — the requester's address
- `message.nonce` — the per-challenge nonce

Everything else (`types`, `primaryType`, `domain`) is either constant or
derived from the cached chain-ID label.

---

## Wallet compatibility notes

ArgentX, Braavos, and Ready all validate typed data against the SNIP-12 JSON
schema. They expect:

- `domain.chainId` — plain decoded string (`"SN_SEPOLIA"` / `"SN_MAIN"`), not
  the raw felt hex.
- `domain.revision: "1"` — required by Ready; harmless for the other wallets.
- `message.action`, `message.wallet`, `message.nonce` — all `felt`-typed
  plain strings.

starknet.js encodes these to felts internally when computing the hash for
`verifyMessageInStarknet`.

---

## Out of scope

- **Nonce generation and expiry** — owned by `src/auth/session.ts`
  (`createChallenge`, `consumeChallenge`).
- **Signature verification** — performed by
  `provider.verifyMessageInStarknet` in `src/routes/auth.ts`; `challenge.ts`
  only builds the typed-data structure.
- **Multiple domain versions** — the domain is fixed at `version: "1"` /
  `revision: "1"`. Supporting future SNIP-12 revisions would require a new
  builder or a version parameter.
