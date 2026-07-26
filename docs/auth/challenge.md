# Challenge Nonce Contract

This document is the authoritative contract for `src/auth/challenge.ts`. It
describes the nonce-challenge generation, expiry, and typed-data boundary
that `src/routes/auth.ts` relies on for wallet-ownership proof. Read this
before adding or moving an auth route that touches challenges.

The implementation in `src/auth/challenge.ts` mirrors this contract line
for line; if the two files ever disagree, this document is the source of
truth and the implementation needs fixing.

## Why this exists

The wallet-login flow has three trust-bearing primitives:

1. The server-issued nonce — proves a wallet signed _for this request_,
   not an old session.
2. The nonce's TTL — closes the window where a stolen nonce can be replayed.
3. The typed-data payload — must match byte-for-byte what the wallet sees
   so the wallet's signature verifies against the same payload the
   backend recorded.

Centralizing them in one module prevents those primitives from drifting as
the route layer is refactored, and gives the test suite one place to
exercise the boundary instead of N places.

## Nonce generation — `createChallenge(address)`

**Inputs:**

| Parameter | Type     | Notes                                         |
| --------- | -------- | --------------------------------------------- |
| `address` | `string` | A Starknet wallet address. Must be parseable. |

**Outputs:**

```ts
{
  nonce: string; // "0x" + 32 hex chars (16 random bytes)
  expires_in_ms: number; // always equals CHALLENGE_TTL_MS (5 minutes)
}
```

**Failure modes — both throw:**

| Cause                                    | Error message                                                  |
| ---------------------------------------- | -------------------------------------------------------------- |
| `address` is not parseable as Starknet   | `createChallenge: address is not a parseable Starknet address` |
| The in-memory store is at MAX_CHALLENGES | `createChallenge: challenge store is full`                     |

A throw is intentional: callers cannot accidentally drop a security-relevant
signal by ignoring a return code. The route handler's `try/catch` propagates
the error to the global error handler.

**Storage key:**

The nonce is stored at `challenges.set(canonicalKey, …)` where
`canonicalKey = normalizeStarknetAddress(address)`. Mixed-case checksum
inputs, `0x`-prefixed / non-prefixed variants, and leading-zero-padding
variants all resolve to the same key.

**Size cap (DoS hardening):**

`MAX_CHALLENGES = 100_000`. Beyond that, `createChallenge` refuses to store.
Without the cap an attacker could spam `createChallenge` from fresh
addresses to grow the Map without bound.

The cap is paired with lazy expiry on access: `getChallenge` (and the
read inside `consumeChallenge`) evict an entry once its TTL has elapsed.
In practice the store only approaches the cap when expired entries pile up
unread, and the next `getChallenge` sweep clears them.

## Nonce retrieval — `getChallenge(address)`

Reads the record for an address, evicting it if expired. Never throws:

| Cause                      | Return value      | Log reason          |
| -------------------------- | ----------------- | ------------------- |
| Address unparseable        | `null`            | `invalid_address`   |
| No record for this address | `null`            | `not_found`         |
| Record present but expired | `null`            | `challenge_expired` |
| Record present and valid   | `ChallengeRecord` | (no log)            |

Read-only: it does NOT delete a still-valid record. Use `consumeChallenge`
on the verify path.

## Nonce clearing — `clearChallenge(address)`

Removes the record. No-op (no throw, no log) for malformed addresses or
when no record exists. Currently called from no route — kept on the
module's public surface for symmetry and for future callers (e.g.
explicit `/auth/challenge/reset`).

## Atomic consume — `consumeChallenge(address)`

This is the **only** safe way to read a challenge immediately before
signature verification. It reads the record and deletes it in a single
step (via `getChallenge` → `challenges.delete`), which closes the
replay-race window:

> If two concurrent `/auth/verify` requests both call `getChallenge`
> before either calls `clearChallenge`, both see the same still-valid
> nonce, both pass verification, and the same challenge is consumed
> twice — a replay bypass.

By deleting inside `consumeChallenge`, the second concurrent caller sees
the record already gone and is rejected by the route handler.

| Cause                        | Return value                               |
| ---------------------------- | ------------------------------------------ |
| Address unparseable          | `null`                                     |
| No record / already consumed | `null`                                     |
| Record expired               | `null` (evicted)                           |
| Record valid                 | `ChallengeRecord` (and deleted from store) |

## Typed-data builder — `buildTypedChallenge(address, chainId, nonce)`

Produces the SNIP-12 typed-data payload the wallet signs.

**Inputs:**

| Parameter | Type     | Notes                                                                                                                               |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `address` | `string` | Wallet address; **normalized** to canonical form in the output.                                                                     |
| `chainId` | `string` | Felt-encoded chain id (`shortString.encodeShortString("SN_SEPOLIA")`). Decoded back to its label before being placed in the domain. |
| `nonce`   | `string` | The hex string issued by `createChallenge`.                                                                                         |

**Why we normalize the wallet field:**

If a caller passes `"0xAbC"` and the backend recorded the nonce under the
canonical `"0xabc"` key, the typed-data `message.wallet` MUST also be
`"0xabc"`. Otherwise the wallet signs a payload with one form and we
record another, and the signature verification step would never match.

`buildTypedChallenge` therefore runs the wallet field through
`normalizeStarknetAddress`. Mixed-case checksum inputs, leading-zero
padding, and `0x`-prefix variants all collapse to one canonical string
before the wallet sees the typed data. If normalize fails, the function
falls back to the lowercased input — the typed-data must always be
buildable so the route does not 500 on a malformed address.

**Output shape:**

```ts
{
  types: { StarknetDomain: [...], Challenge: [...] },
  primaryType: "Challenge",
  domain: { name: "StelloPay", version: "1", chainId: "SN_SEPOLIA", revision: "1" },
  message: { action: "LOGIN", wallet: <canonical>, nonce },
}
```

## How callers consume this module

`src/routes/auth.ts` uses three of the four entry points:

| Route                  | Calls                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/challenge` | `createChallenge(address)` then `buildTypedChallenge(address, chainId, nonce)`                                                  |
| `POST /auth/verify`    | `consumeChallenge(address)` then `buildTypedChallenge(address, chainId, ch.nonce)` then `provider.verifyMessageInStarknet(...)` |
| (no caller)            | `getChallenge(address)`, `clearChallenge(address)` — kept public for symmetry and future routes                                 |

The route layer's Zod schema (`z.object({ address: z.string().min(3) })`)
catches truly malformed input first; the helpers in `challenge.ts` are
defense-in-depth.

## Tests

`src/auth/challenge.test.ts` covers the contract:

- **Build typed-data**: chainId decoding, primaryType, message fields,
  domain shape, mixed-case wallet normalization.
- **Generation / expiry**: nonces are 16 bytes hex, TTL is constant,
  expiry evicts on access.
- **Miss / clear / consume**: success and all miss reasons, atomic
  delete-on-consume closes the replay race.
- **Defense-in-depth**: malformed addresses resolve to null / no-op
  without throwing for `getChallenge`, `clearChallenge`,
  `consumeChallenge`; throw for `createChallenge`.
- **Size cap**: store accepts up to MAX_CHALLENGES, refuses beyond it,
  recovers after lazy expiry evicts the old entries.

## Out of scope

The following are explicitly NOT part of this contract:

- Replacing the in-memory store with a Redis-backed shared store (would
  matter for multi-instance deployments — issue is tracked separately).
  The in-memory `MAX_CHALLENGES = 100_000` cap is **per process**: a
  multi-instance deployment multiplies the system-wide memory bound by
  replica count. Switching to a shared store is the way to bound the
  cluster-wide.
- Replacing the address-keyed Map with a nonce-keyed one (current
  per-address scheme is correct as long as `consumeChallenge` stays the
  only entry point on the verify path).
- Adding rate limiting at this layer — see `middleware/rate-limit.ts`.
- Signature verification itself — see `starknet/client.ts`'s
  `provider.verifyMessageInStarknet`.
- Session creation, which lives in `auth/session.ts`.
