# Stock Inquiry Server-Side Pagination — Implementation Contract

## Status
Implementation in progress. The PostgreSQL list, summary, and facet endpoints are now connected to the analytical stock-inquiry UI. The analytical table requests one 15-row page at a time; KPI aggregates and stock-dependent facets come from PostgreSQL. Coil-pack number is now a separate exact-match filter from material-lot / coil ID. This is not yet the final server-side migration: the module still downloads the full stock-balance result for dashboard, reorder-alert, Cardex, grouping, and CSV consumers. Those consumers must be migrated or explicitly proven to require the complete collection before the module-wide full fetch can be removed.

Additional migration milestones:
- Grouped inquiry details now have a separate `detailsOnly=true` mode on the grouped endpoint. It scopes by the selected group, returns one page (default 50, max 100), and the UI requests details only when a group is expanded. A "load next 50" action retrieves subsequent rows. Filter changes invalidate the detail cache.
- The Cardex part selector now reads its stock totals and warehouse-location summary from `/part-summary`; that endpoint uses Prisma database `groupBy` by part and quality status plus a distinct part/warehouse query. The UI loads stock detail only for the selected part and shows explicit summary/detail errors instead of treating a failed query as zero stock.
- Remaining grouped-inquiry limitation: group-header totals are still computed by loading all matching StockBalance rows into the server process. They are no longer calculated in the browser, but database-level grouped aggregation is still required to avoid loading the entire filtered set on every group-summary request.

- The grouped inquiry now has a PostgreSQL-backed `/inventory/stock-inquiry/grouped` endpoint using the shared stock-inquiry filter predicate. The UI uses its complete-result group totals and counts; an HTTP integration assertion covers coil-pack totals and rejects unsupported grouping keys.
- Important limitation: this first grouped endpoint currently selects the filtered stock rows on the server and aggregates them in application memory. It prevents client-side total calculation from defining the totals, but it is not yet a database `GROUP BY` implementation and is not the final scalability target. Group detail rows are also still sourced from the parent-provided balance collection. The next grouped-inquiry step is database-level aggregation plus lazy, group-scoped detail loading.

- Warehouse-level and per-part stock summary endpoints now back the inventory dashboard warehouse cards and reorder-alert calculations. The detailed-balance calculation remains as a fallback if a summary request is unavailable.
- Cardex now loads only the selected part's posted transactions from the immutable PostgreSQL inventory ledger; the old all-documents download and browser-side running-balance reconstruction have been removed.
- CSV export now streams the complete filtered stock result from PostgreSQL in batches; the browser no longer builds the export from its in-memory balance collection.

Latest verified implementation commit: `93439bc4eba25e8c4c864508b6d404c0fea279fa`
CI run: [43836068689](https://github.com/vaheme64-design/kosartest_postgres_rebuilt/actions/runs/43836068689) — success. The inventory HTTP integration test verifies selected-part Cardex ledger output and filtered CSV export row count/content.

Still open: grouped inquiry is calculated from the full parent-provided balance collection; the parent module still loads the full stock-balance list for operational forms and legacy consumers. These must be migrated before removing that fetch.


- The Cardex part selector migration is now connected to the view: its summary is database-aggregated by part/quality status, and selected-part stock detail is fetched separately (up to 200 rows per request). The StockInquiryView no longer accepts the parent full-balance prop; its list, KPI summary, facets, grouped totals, group detail, Cardex ledger and selected-part stock detail are API-backed.
- The dashboard no longer receives detailed balances and no longer calculates warehouse cards from a full-balance fallback. It displays an explicit unavailable state when the warehouse summary API fails.
- Reorder alerts no longer fall back to the full balance array when the per-part summary fails. In that case alert calculation is stopped and an explicit error is shown; stage inventory remains the intentional fallback only when a successful warehouse summary confirms no warehouse rows for that part.
- Issue, Transfer and Adjustment modals no longer receive the parent balances collection; their stock lookups are scoped to the selected part/warehouse.
- The parent InventoryModuleView no longer calls `GET /api/inventory/stock-inquiry` without pagination and no longer stores a module-wide `balances` array. The remaining WIP stage report uses its separate stage-balance data source.

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

## Consumer audit — 2026-11-16 (updated)

The module-wide full-balance dependency is **not removed**. The following scoped migrations are now implemented:

| Consumer | Current state | Evidence / remaining work |
|---|---|---|
| `IssueFormModal` | Loads stock for selected part and preferred warehouse from PostgreSQL; falls back to other warehouses only when preferred warehouse has no available stock. Removed stale per-part badge calculated from global balances. | Commits `9c88fe5`, `c277962`; CI for `9c88fe5` passed; CI for `c277962` is pending at this update. |
| `TransferFormModal` | Loads stock for selected part and source warehouse. Available quantity and lot choices now both use the scoped result, not the global balances prop. | Commits `b2bd266`, `96ea236`; CI for `b2bd266` passed; CI for `96ea236` is pending at this update. |
| `AdjustmentFormModal` | Loads stock rows for selected part and warehouse from PostgreSQL; current balance selection uses this scoped result. | Commit `61712f0`; CI run [43862849837](https://github.com/vaheme64-design/kosartest_postgres_rebuilt/actions/runs/43862849837) — success. |
| `StockInquiryView` grouped rows | Group headers come from the grouped API; expanded details are fetched per group in 50-row pages. | Group header endpoint still loads all filtered StockBalance rows in server memory; replace with database-level aggregation. |
| `StockInquiryView` part/Cardex selector | Totals and warehouse locations use DB-grouped per-part summary; selected part detail loads through the paginated stock inquiry API. Cardex history remains independently PostgreSQL-backed. | Validate full selector workflow; selected-part detail currently requests up to 200 rows in one page. |
| `InventoryDashboard` | No longer receives detailed balances; warehouse cards use the summary endpoint and show unavailable state on error. | Complete end-to-end acceptance against real factory data. |
| Reorder alerts | Uses per-part PostgreSQL summary; stops calculation and displays an error if the summary fails. | Complete end-to-end acceptance against real factory data. |
| Parent inventory module | Still calls `/api/inventory/stock-inquiry` without pagination and stores all returned balances. | Keep until grouped inquiry, Cardex selector, dashboard, reorder alerts and any remaining consumers are migrated. |

### Updated safe next sequence

1. Complete CI for the latest transfer availability fix and issue-selector cleanup; correct any failures before treating these slices as accepted.
2. Add integration coverage for server-side grouped aggregates and on-demand group detail retrieval, using the same `buildStockInquiryWhere` predicate as list, summary and export.
3. Replace the inquiry view's client-side grouping and per-part balance scan; do not return every matching stock row merely to calculate group totals.
4. Remove dashboard and reorder-alert full-balance fallbacks only after PostgreSQL summary failures are surfaced as explicit errors.
5. Change parent loading so detailed balances are fetched only by a workflow that demonstrably needs them; audit every `balances` prop consumer before removing the module-wide fetch.
6. Run full CI, database-backed lifecycle tests, TypeScript/build checks and manual acceptance against the user's PostgreSQL environment.

This audit does not claim full-fetch removal or completion of the SAP Fiori-style UX redesign. The standard stock list is paginated and the CSV/Cardex paths are PostgreSQL-backed, but grouped inquiry and the part/Cardex selector still depend on the full client collection.
