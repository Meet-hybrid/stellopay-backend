# Read Route Documentation

This document defines the strict contracts for pagination and batching across `src/routes/read.ts` and its consumers.

## Cursor-Based Pagination

When an endpoint supports cursor-based pagination to read streams of events or records, it MUST use `CursorPaginationSchema` to validate the incoming query parameters. 

```typescript
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```
- **limit**: Caps results per page. Minimum 1, Maximum 100, Default 50.
- **cursor**: A string representing the starting position for the next page. 

The successful response MUST match the generic `PaginatedReadResponse<T>` shape:

```typescript
export interface PaginatedReadResponse<T> {
  data: T[]; // The actual array of records
  nextCursor: string | null; // The cursor to use for the next page, or null if there are no more pages
  hasMore: boolean; // True if there are more records remaining
  limit: number; // The limit that was applied to the query
}
```

## Batching

When reading multiple discrete items by their ID (e.g. fetching summaries for multiple agreements), endpoints MUST use `BatchReadSchema` to prevent oversized queries or resource exhaustion.

```typescript
export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});
```
- **ids**: A non-empty array of positive bigints.
- **Max Batch Size**: Hardcoded to 50 items per request to keep RPC calls and database lookups constrained.
