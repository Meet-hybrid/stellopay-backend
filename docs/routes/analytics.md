# Analytics Routes

The `analytics` router provides endpoints for aggregating platform activity and transaction data.

## Endpoints

### GET `/api/v1/analytics/:user_address`

Retrieves monthly aggregated data for a specific user.

**Path Parameters**
- `user_address` (string): The Starknet address of the user.

**Query Parameters**
- `year` (number, optional): The year to fetch data for. Defaults to the current year.

**Response**
Returns an object containing the year, a 12-month array of monthly activity ("views"), and a total value.
- `year` (number): The year queried.
- `data` (array): 12 items (Jan-Dec) containing:
  - `month` (string): 3-letter month abbreviation.
  - `views` (number): The net financial activity for the month.
- `total` (number): The total activity across all 12 months.

### Aggregation Rules

The route calculates a net financial amount across payments and escrow events:
- **Payments**: 
  - Incoming payments (`to === user_address`) add to the net total.
  - Outgoing payments (`from === user_address`) subtract from the net total.
- **Escrow Events**:
  - `Funded`: Subtracts from the net total for the employer.
  - `Released`: Adds to the net total for the contributor (`to`).
  - `Refunded`: Adds to the net total for the employer.
  
**Agreement Fallback**:
If a user has **no financial activity** (0 payments and 0 escrow events) in the given year, the route falls back to displaying agreement creation counts. Each agreement adds a visual baseline of `1000` base units (0.001 token amount assuming 6 decimals) to ensure the chart is populated for new but active users. This fallback is fully suppressed if any financial activity exists.
