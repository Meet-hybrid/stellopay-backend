# Database Schema - Pagination and Batching Contract

## Pagination

All list endpoints must respect:
- MAX_PAGE_SIZE = 100 - maximum rows per page
- DEFAULT_PAGE_SIZE = 50 - used when no limit is specified
- Use clampPageLimit(requested) to sanitize caller input

## Batching

Bulk operations must respect:
- MAX_BATCH_SIZE = 100 - maximum rows per batch
- Use clampBatchSize(requested) which returns 0 for invalid sizes

## Migration Safety

- Every FK-shaped column (ending in Id) must have a btree index
- Enforced by schema-consistency.test.ts
- New tables must declare indexes in the table callback
