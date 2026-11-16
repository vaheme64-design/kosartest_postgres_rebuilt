# Stock Inquiry Server-Side Pagination — Implementation Contract

## Status
Design baseline for the next inventory inquiry implementation step. This document does not change runtime behavior or business rules.

## Current verified behavior
- `GET /api/inventory/stock-inquiry` reads relational `StockBalance` data and already accepts pagination and several filters.
- The API response includes `data`, `total`, `page`, `pageSize`, and `totalPages`.
- Thickness and exact coil-pack filters are supported by the API.
- `InventoryModuleView` currently fetches `/api/inventory/stock-inquiry` without paging parameters and stores the returned rows in module-level `balances`.
- `StockInquiryView` then filters, sorts, groups, aggregates, exports, and paginates that in-memory array. Its page size is 15.
- The Cardex path also depends on inventory documents and must not be accidentally restricted to the currently visible stock page.

## Non-negotiable invariants
1. PostgreSQL `StockBalance` remains the authoritative stock read model.
2. Do not change inventory, reservation, ownership, QC, contract, coil, or WIP business semantics as part of this UI performance change.
3. Every list, summary, grouped result, and export must use the same normalized filter definition.
4. KPI values must represent the complete filtered result, not only the current page.
5. CSV export must represent the complete filtered result, not only the current page.
6. Cardex must load the selected part's full movement history independently of stock-table pagination.
7. Facet options must not be derived from only the current page.
8. Changing any filter or sort resets the page to 1. Changing page must not change filter state.
9. Keep `main` unchanged; all work stays on `improvement/enterprise-ux-and-control-review`.

## Normalized query contract
The client query state should support:
- `page`, `limit`
- `search`
- `partId`, `warehouseId`
- `ownership`, `grade`
- `thicknessMm`, `coilPackNumber` (exact coil-pack match; do not confuse with lot number)
- `contractNumber`, `lotNumber`
- `onlyAvailable` / equivalent explicit boolean
- `includeZero`
- `sortField`, `sortDirection`

All values must be validated server-side. Sort fields must be allow-listed; never interpolate arbitrary client field names into Prisma order clauses.

## Required server capabilities
### 1. Shared filter builder
Extract a pure, typed query-normalization/filter-builder function. Both the paginated list and every aggregate/export endpoint must call the same implementation. Preserve the current semantics of existing filters and add explicit validation for boolean and sorting inputs.

### 2. Paginated list
Keep `GET /inventory/stock-inquiry` backward compatible for existing consumers while accepting the normalized query contract. Return the existing pagination metadata. The UI should request only the current page when the analytical table is active.

### 3. Summary
Add a filtered summary endpoint returning complete-result aggregates:
- row count
- physical quantity/weight
- available quantity/weight
- reserved quantity/weight
- QC-blocked quantity/weight
- SAPCO-owned weight

Use database aggregation where possible. Ensure the summary uses exactly the same filter predicate as the list. Do not sum duplicated representations of the same physical stock.

### 4. Facets
Provide stable filter options independent of the current page. Prefer master-data endpoints for parts and warehouses, and a server facet endpoint for stock-dependent values such as contract numbers, lot numbers, grades, thicknesses, and coil-pack numbers. Facet queries should honor the other active filters where that behavior is intentional, but must not self-filter a facet in a way that makes its selected value disappear.

### 5. Export
Add a server export path that applies the same normalized filters and returns every matching row (or a streamed CSV for large result sets). The UI must not export only the 15 visible rows or fetch all rows into React state merely to export them.

### 6. Grouped inquiry
When grouping is selected, calculate group totals over the complete filtered set on the server. Do not build group totals from the current page. Keep row expansion/detail loading separate from aggregate calculation.

### 7. Cardex
Cardex remains a separate part-scoped workflow. Load the selected part's complete document/transaction history through its own API query. Do not reuse the stock table page data as a Cardex source.

## Frontend migration sequence
1. Introduce a typed query-state model and a request serializer; keep the current table behavior while adding unit tests for query serialization.
2. Add summary and facet APIs, with integration tests proving their filters match list results.
3. Change the stock inquiry table to fetch page data from the API; keep KPI, filters, and group totals backed by summary/facets/group endpoints.
4. Move CSV export to the server export endpoint.
5. Verify Cardex remains independent and correct.
6. Remove obsolete client-side full-dataset filtering/pagination only after all consumers have migrated. Do not remove the module-wide balances fetch until dashboard/reorder-alert/other-tab consumers have been separately migrated or proven to require it.

## Acceptance tests
- Same filter combination yields consistent row count between list metadata and summary.
- A filter returning more than one page yields stable page sizes and correct final-page behavior.
- Sorting is stable across page boundaries and rejects unknown sort fields.
- Thickness and coil-pack filters combine correctly with search, contract, grade, part, and warehouse filters.
- KPI totals remain unchanged when moving between pages.
- Facet options include valid values not present on the current page.
- Export count and aggregate totals match the complete filtered query.
- Group totals match the ungrouped complete result.
- Cardex result is unchanged when the stock table page changes.
- Empty result, invalid page, invalid limit, and malformed filters have explicit tested behavior.
- Existing inventory HTTP lifecycle tests continue to pass.

## Delivery rule
Do not call this complete until the frontend no longer downloads the full stock-balance dataset for the inquiry table, all dependent views remain correct, the HTTP integration tests and TypeScript/build checks pass, and a real database-backed acceptance run has been performed. CI success alone is not proof of production database correctness.
