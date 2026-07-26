# Backfill Events

**Overview:**
The backfill endpoints allow administrators to synthesize events for employees and milestones that exist in the database but have not yet emitted or indexed their corresponding events (`EmployeeAdded` or `MilestoneAdded`).

These endpoints are used to restore a consistent indexer state safely.

## Endpoints

- `POST /api/v1/backfill/employee-events`
- `POST /api/v1/backfill/milestone-events`

### Authentication and Authorization
Both routes require an active admin session.

### Query Parameters

| Parameter     | Type   | Default | Max    | Description                                      |
| ------------- | ------ | ------- | ------ | ------------------------------------------------ |
| `limit`       | number | `1000`  | `5000` | Maximum number of rows to scan.                  |
| `agreementId` | string | —       | —      | Restrict backfill to a single agreement.         |

*The default limit is defined by `DEFAULT_BACKFILL_LIMIT` (1000) and the maximum is defined by `MAX_BACKFILL_LIMIT` (5000).*

### Safe and Idempotent Inserts

To guarantee that synthesized backfill events never collide with genuine on-chain events and that operations are safely repeatable:

1. **Synthetic Event IDs**: 
   A backfill event uses the format: 
   `{transactionHash}_backfill_{eventType}_{rowId}`
   *(Implemented via the `buildBackfillEventId` helper).*
   Because genuine on-chain events use `{txHash}_{eventIndex}`, the `_backfill_` segment ensures collisions are impossible.

2. **Sentinel Event Index**:
   Every backfill row is inserted with an `eventIndex` of `-1` (`BACKFILL_EVENT_INDEX`). Real on-chain events always have an `eventIndex >= 0`.

3. **Transaction Safety**:
   The database inserts run within a single transaction using `ON CONFLICT DO NOTHING`, rendering repeat calls completely safe (no-ops for already backfilled events).

### Response Contract

Both endpoints return a `BackfillResponse` with the following shape:

```json
{
  "message": "Backfilled 3 EmployeeAdded events",
  "totalScanned": 10,
  "created": 3,
  "results": [
    {
      "employeeId": "emp_1",
      "agreementId": "agr_123",
      "status": "created"
    }
  ]
}
```

The `results` array contains a preview sample limited to a maximum of 10 items (`RESULTS_PREVIEW_SIZE`). For the milestone endpoint, `milestoneId` is returned instead of `employeeId`.

## Edge Cases (Out of Scope)
- **Automatic scaling / pagination**: The caller must issue repeated requests or adjust the `limit` up to `MAX_BACKFILL_LIMIT` if the number of missing rows is extremely large.
- **Handling of events missing transaction hashes**: Records inserted through out-of-band means that completely lack an original `transaction_hash` cannot be safely backfilled using these routes, as the synthetic ID heavily relies on the source transaction hash.
