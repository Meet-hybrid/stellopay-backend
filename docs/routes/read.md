# Read Route Documentation

This document explicitly defines the backwards-compatible behavior for cursor-based reads, record ordering, and batching in `src/routes/read.ts`. Future changes must preserve these exact contracts to ensure safe maintenance for existing consumers.

## Cursor-Based Pagination

When an endpoint supports cursor-based pagination, it MUST use `CursorPaginationSchema` to validate the incoming query parameters.

```typescript
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

- **limit**: Maximum number of records to return. Minimum is 1, maximum is 100, and defaults to 50 if omitted.
- **cursor**: A string token indicating the position for the next page of results. Omit for the first page.

The corresponding response MUST adhere to the generic `PaginatedReadResponse<T>` shape:

```typescript
export interface PaginatedReadResponse<T> {
  data: T[]; // Array containing the paginated records
  nextCursor: string | null; // The opaque string to pass as `cursor` for the next page, or null if end of stream
  hasMore: boolean; // Indicates if further pages exist
  limit: number; // The limit applied to this request
}
```

## Batch Operations

Endpoints fetching discrete resources by an explicit list of identifiers MUST validate the request via `BatchReadSchema` to guard against runaway backend scans.

```typescript
export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});
```

- **ids**: A non-empty array of positive `BigInt` equivalents (often transmitted as strings).
- **Hard Bounds**: A minimum of 1 and a strict maximum of 50 IDs per request. Re-batch larger datasets on the client.
