# Cursor-Based Reads API Contract

This document describes the API contract for the cursor-based reads and record ordering endpoints owned by `src/routes/read.ts`.

## `GET /api/v1/records/cursor/:address`

Retrieves a paginated list of records for a specific address using cursor-based pagination.

### Authentication

This endpoint strictly requires a bearer token in the `Authorization` header. The token must exactly match the `:address` path parameter to verify privilege and prevent access authorization gaps (drift).

**Header:**
`Authorization: Bearer <address>`

### Query Parameters

- `cursor` (string, optional): A token used to fetch the next page of records.
- `order` (enum: `asc`, `desc`): The ordering of the records. Defaults to `desc`.
- `limit` (number, optional): The number of records to return. Min: 1, Max: 100. Defaults to 50.

### Responses

- **200 OK**:
  ```json
  {
    "address": "0x1234",
    "records": [],
    "nextCursor": null,
    "order": "desc"
  }
  ```

- **401 Unauthorized**: If the `Authorization` header is missing.
- **403 Forbidden**: If the `Authorization` token fails the privilege check (i.e., does not match the target address).
