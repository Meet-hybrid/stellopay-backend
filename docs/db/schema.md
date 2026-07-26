# Database Schema

Source of truth: [`src/db/schema.ts`](../../src/db/schema.ts)

## Overview

All tables are defined with [Drizzle ORM](https://orm.drizzle.team/) and targeting PostgreSQL.
Migrations live in [`src/db/migrations/`](../../src/db/migrations/) and are applied via
`pnpm db:migrate` (or `pnpm db:migrate -- --dry-run` for a preview).

---

## Tables

### `agreements`

Stores agreement creation and lifecycle status. One row per agreement.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `agreement_id` as decimal string |
| `contract_address` | `text` | NOT NULL | Starknet contract address |
| `employer` | `text` | NOT NULL | Employer wallet address |
| `contributor` | `text` | nullable | Contributor wallet address (null for Payroll mode) |
| `token` | `text` | NOT NULL | ERC-20 token address |
| `mode` | `integer` | NOT NULL, CHECK IN (0,1) | 0 = Escrow, 1 = Payroll |
| `payment_type` | `integer` | NOT NULL, CHECK IN (0,1,2) | 0 = None, 1 = TimeBased, 2 = MilestoneBased |
| `status` | `integer` | NOT NULL, CHECK BETWEEN 0 AND 5 | 0 Created, 1 Active, 2 Paused, 3 Cancelled, 4 Completed, 5 Disputed |
| `total_amount` | `text` | NOT NULL, CHECK u256 | Cairo u256 as decimal string |
| `paid_amount` | `text` | NOT NULL, CHECK u256 | Cairo u256 as decimal string |
| `dispute_status` | `integer` | DEFAULT 0, CHECK IN (0,1,2) | 0 None, 1 Raised, 2 Resolved |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | Block at which the event was emitted |
| `transaction_hash` | `text` | NOT NULL | Transaction hash |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | Managed by the indexer |

Indexes: `contract_address`, `employer`, `contributor`, `status`.

---

### `agreement_events`

Append-only log of all events emitted by an agreement contract.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `transaction_hash + ":" + event_index` |
| `agreement_id` | `text` | NOT NULL | FK-shaped → `agreements.id` |
| `contract_address` | `text` | NOT NULL | |
| `event_type` | `text` | NOT NULL | e.g. `AgreementCreated`, `AgreementActivated` |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | |
| `event_index` | `integer` | NOT NULL, CHECK >= 0 | Position within the transaction |
| `transaction_hash` | `text` | NOT NULL | |
| `created_at` | `timestamp` | NOT NULL | |

Indexes: `agreement_id`, `contract_address`, `event_type`, `block_number`.

---

### `payments`

One row per `PaymentSent` / `PaymentReceived` on-chain event.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `tx_hash + ":" + event_index` |
| `agreement_id` | `text` | NOT NULL | FK-shaped → `agreements.id` |
| `contract_address` | `text` | NOT NULL | |
| `from_address` | `text` | NOT NULL | Sender address |
| `to_address` | `text` | NOT NULL | Recipient address |
| `amount` | `text` | NOT NULL, CHECK u256 | u256 as decimal string |
| `token` | `text` | NOT NULL | ERC-20 token address |
| `event_type` | `text` | NOT NULL, CHECK IN ('PaymentSent','PaymentReceived') | |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | |
| `transaction_hash` | `text` | NOT NULL | |
| `created_at` | `timestamp` | NOT NULL | |

Indexes: `agreement_id`, `from_address`, `to_address`, `block_number`.

---

### `milestones`

One row per milestone (created or updated) on a MilestoneBased agreement.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `agreement_id + ":" + milestone_id` |
| `agreement_id` | `text` | NOT NULL | FK-shaped → `agreements.id` |
| `contract_address` | `text` | NOT NULL | |
| `milestone_id` | `integer` | NOT NULL, CHECK >= 0 | On-chain milestone index |
| `amount` | `text` | NOT NULL, CHECK u256 | u256 as decimal string |
| `approved` | `boolean` | DEFAULT false | |
| `claimed` | `boolean` | DEFAULT false | |
| `claimed_by` | `text` | nullable | Address that claimed the milestone |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | |
| `transaction_hash` | `text` | NOT NULL | |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | |

Indexes: `agreement_id`, `milestone_id`.

---

### `employees`

One row per employee registered in a Payroll agreement.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `agreement_id + ":" + employee_index` |
| `agreement_id` | `text` | NOT NULL | FK-shaped → `agreements.id` |
| `contract_address` | `text` | NOT NULL | |
| `employee_address` | `text` | NOT NULL | Employee wallet address |
| `employee_index` | `integer` | NOT NULL, CHECK >= 0 | On-chain index |
| `salary_per_period` | `text` | NOT NULL, CHECK u256 | u256 as decimal string |
| `claimed_periods` | `integer` | DEFAULT 0, CHECK >= 0 | |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | |
| `transaction_hash` | `text` | NOT NULL | |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | |

Indexes: `agreement_id`, `employee_address`.

---

### `escrow_events`

One row per escrow `Funded` / `Released` / `Refunded` event.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | `tx_hash + ":" + event_index` |
| `agreement_id` | `text` | NOT NULL | FK-shaped → `agreements.id` |
| `contract_address` | `text` | NOT NULL | |
| `event_type` | `text` | NOT NULL, CHECK IN ('Funded','Released','Refunded') | |
| `employer` | `text` | NOT NULL | Employer address |
| `to_address` | `text` | nullable | Recipient (Released/Refunded only) |
| `amount` | `text` | NOT NULL, CHECK u256 | u256 as decimal string |
| `block_number` | `bigint` | NOT NULL, CHECK >= 0 | |
| `transaction_hash` | `text` | NOT NULL | |
| `created_at` | `timestamp` | NOT NULL | |

Indexes: `agreement_id`, `contract_address`, `event_type`, `block_number`.

---

### `billing_profiles`

One row per user billing identity. Sensitive fields are stored but never
returned by API responses — see the `stripSensitive` helper in
`src/routes/billing.ts`.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | UUID or wallet-derived id |
| `owner_address` | `text` | NOT NULL, UNIQUE | Starknet wallet address |
| `profile_type` | `text` | NOT NULL, CHECK IN ('Individual','Business'), DEFAULT 'Individual' | |
| `annual_reward_limit` | `numeric(18,6)` | NOT NULL, CHECK >= 0, DEFAULT 0 | |
| `used_amount` | `numeric(18,6)` | NOT NULL, CHECK >= 0, DEFAULT 0 | |
| `currency` | `text` | NOT NULL, CHECK `^[A-Z]{3}$`, DEFAULT 'USD' | ISO 4217 code |
| `first_name` … `notes` | `text` | nullable | General / business contact fields |
| `tax_id` | `text` | nullable | **Sensitive** — EIN/SSN, never returned by API |
| `date_of_birth` | `text` | nullable | **Sensitive** — ISO date string, never returned by API |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | |

Indexes: `owner_address` (also covered by the UNIQUE constraint).

---

### `billing_payment_methods`

Payment methods attached to a billing profile. Only masked/safe
representations are persisted (no raw account or routing numbers).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | |
| `profile_id` | `text` | NOT NULL | FK-shaped → `billing_profiles.id` |
| `type` | `text` | NOT NULL, CHECK IN ('bank_account','paypal','crypto','wire','check','other') | |
| `display_name` | `text` | nullable | e.g. "Chase ****1234" |
| `masked_account` | `text` | nullable | e.g. "****1234" |
| `masked_routing` | `text` | nullable | e.g. "****5678" |
| `email` | `text` | nullable | For PayPal / similar |
| `is_default` | `boolean` | NOT NULL, DEFAULT false | |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | |

Indexes: `profile_id`.

---

### `billing_invoices`

Invoice records associated with a billing profile.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | |
| `profile_id` | `text` | NOT NULL | FK-shaped → `billing_profiles.id` |
| `invoice_number` | `text` | NOT NULL, UNIQUE | |
| `amount` | `numeric(18,6)` | NOT NULL, CHECK >= 0 | |
| `currency` | `text` | NOT NULL, CHECK `^[A-Z]{3}$`, DEFAULT 'USD' | ISO 4217 code |
| `status` | `text` | NOT NULL, CHECK IN ('pending','paid','void'), DEFAULT 'pending' | |
| `description` | `text` | nullable | |
| `issued_at` | `timestamp` | NOT NULL | |
| `paid_at` | `timestamp` | nullable | |
| `created_at` / `updated_at` | `timestamp` | NOT NULL | |

Indexes: `profile_id`, `status`.

---

### `sessions`

Auth sessions with sliding and absolute expiry.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `token_hash` | `text` | PK | bcrypt/SHA hash of the raw session token |
| `address` | `text` | NOT NULL | Wallet address that owns the session |
| `created_at` | `timestamp` | NOT NULL | |
| `expires_at` | `timestamp` | NOT NULL | Sliding expiry deadline |
| `absolute_expires_at` | `timestamp` | NOT NULL | Hard upper bound regardless of activity |
| `revoked_at` | `timestamp` | nullable | Set when explicitly revoked |
| `last_seen` | `timestamp` | nullable | Updated on each authenticated request |
| `family_id` | `text` | nullable | Groups all tokens from one login chain (BE-154) |
| `rotated_at` | `timestamp` | nullable | Set when this token is rotated out (BE-154) |

Indexes: `address`, `family_id`.

---

## Constraint conventions

### u256 amounts

All `amount`, `total_amount`, `paid_amount`, and `salary_per_period` columns that carry
a Cairo `u256` value store it as a **decimal string**. The database enforces this with:

```
CHECK (column ~ '^(0|[1-9][0-9]{0,77})$')
```

- Accepts `"0"` and positive integers up to 78 digits (the maximum decimal width of 2²⁵⁶ − 1).
- Rejects empty strings, leading zeros (other than `"0"` itself), negatives, decimals, and
  any non-numeric characters.

### Currency codes

`currency` columns use:

```
CHECK (currency ~ '^[A-Z]{3}$')
```

Exactly three uppercase ASCII letters — consistent with ISO 4217 (e.g. `USD`, `EUR`, `GBP`).

### Block numbers and counters

`block_number`, `event_index`, `milestone_id`, `employee_index`, and `claimed_periods` all carry
`CHECK (column >= 0)` to prevent nonsensical negative values reaching downstream code.

### Enum-style integer columns

`mode`, `payment_type`, `status`, and `dispute_status` on the `agreements` table use
`CHECK IN (...)` or `CHECK BETWEEN` to enforce the closed set of valid values defined
by the Cairo contract.

### Enum-style text columns

`event_type` on `payments` and `escrow_events`, `profile_type` on `billing_profiles`,
`status` on `billing_invoices`, and `type` on `billing_payment_methods` all use
`CHECK IN (...)`.

---

## Migration safety

Migrations are run with a PostgreSQL advisory lock (`pg_advisory_lock`) so that only one
process can migrate at a time in a multi-replica deployment.

The `--dry-run` flag prints pending migrations without touching the schema:

```sh
pnpm db:migrate -- --dry-run
```

Each new migration file must be registered in
[`src/db/migrations/meta/_journal.json`](../../src/db/migrations/meta/_journal.json).

### Out-of-scope notes

- **Row-level security (RLS)** — not yet applied. `billing_profiles.tax_id` and
  `date_of_birth` are sensitive but rely on application-layer stripping rather than
  database-level RLS for now.
- **Foreign key constraints** — not declared at the database level; referential integrity
  is maintained by the indexer write path. This avoids lock contention on high-throughput
  event ingestion.
