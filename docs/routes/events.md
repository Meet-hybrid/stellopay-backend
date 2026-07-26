# Event Ingestion

Source: [`src/routes/events.ts`](../../src/routes/events.ts)

**Overview:**
These endpoints fetch a Starknet transaction receipt, decode its events using
the WorkAgreement and PayrollEscrow contract ABIs, and persist the decoded
data (`agreements`, `agreementEvents`, `payments`, `escrowEvents`) to
Postgres. Both routes delegate to the same shared processor,
`processTxReceipt`, so a single tx hash is always decoded and stored the same
way whether it arrives via `process_tx` or as part of a `process_batch`.

## Endpoints

- `POST /api/v1/events/process_tx/:tx_hash`
- `POST /api/v1/events/process_batch`

### Authentication and Authorization

Both routes require an active **admin** session (`requireAuth` followed by
`requireAdmin`).

Ingestion is a privileged write path, not a read: it inserts/updates
`agreements`/`agreementEvents`/`payments`/`escrowEvents` rows for whatever tx
hash the caller supplies, and — for transactions containing an
`AgreementCreated` event — calls the on-chain contract and overwrites the
stored agreement's `token` if it disagrees with the event payload. An
authenticated-but-non-admin caller must not be able to trigger any of this for
an arbitrary transaction. This matches the admin-only gate already used by
the sibling ingestion routes in `backfill-events.ts` and `reprocess-events.ts`
— `events.ts` is the one place in this family that previously stopped at
`requireAuth` alone.

### `POST /events/process_tx/:tx_hash`

Processes a single transaction. Responses:

| Condition | Response |
|---|---|
| Receipt not found | `404 { error: "Transaction not found" }` |
| Receipt has no events | `200 { message: "No events found in transaction", eventsProcessed: 0 }` |
| Events decoded | `200 { message, eventsProcessed: string[], transactionHash, tokenVerified? }` |

### `POST /events/process_batch`

Processes multiple transactions in one request.

- **Body:** `{ tx_hashes: string[] }` — non-empty, each a valid Starknet tx
  hash, capped at `MAX_BATCH_SIZE` (50) entries per request.
- Each tx hash is processed independently via the same `processTxReceipt`
  logic as `process_tx`; a per-tx failure is captured into that entry's
  `error` field rather than aborting the rest of the batch.
- **Response:** `{ summary: { total, processed, noEvents, notFound, errors, totalEventsProcessed }, results: TxProcessResult[] }`.

### Idempotency

All inserts use `onConflictDoNothing`/`onConflictDoUpdate` keyed on
deterministic IDs (`{txHash}_{eventIndex}` for events, the agreement ID for
agreements), so re-submitting the same tx hash — via `process_tx`, within a
`process_batch`, or across both — never creates duplicate rows.

### Token verification

For an `AgreementCreated` event, after the agreement row is upserted, the
on-chain contract's `get_token` is called and compared against the token
taken from the event. If they disagree, the on-chain value is authoritative
and the stored row is corrected before the response is sent (awaited, not
fire-and-forget). `tokenVerified` on the response is `true` when this check
completed for every `AgreementCreated` event in the transaction, `false` if
at least one check failed, and omitted entirely when the transaction had no
`AgreementCreated` event.

## Out of scope

- **Contract/agreement-level authorization** — the admin gate controls *who*
  may trigger ingestion, not *which* contracts or agreements an admin may
  ingest for. Any admin can process a receipt for any contract address; there
  is no per-contract allowlist here.
- **Fan-out / notification delivery on ingestion** — these routes only
  persist decoded events; they do not push notifications or webhooks to
  affected users as a side effect of processing.
- **Receipt schema validation beyond structural checks** — `processTxReceipt`
  trusts the shape of whatever the configured Starknet `provider` returns for
  a receipt; it does not independently re-verify the receipt against a second
  RPC source.
