# KPIMS Enterprise Review — Iteration 1

**Repository:** `vaheme64-design/kosartest_postgres_rebuilt`  
**Baseline:** `main` at `a504f24bf09a632a576927324fab1710de398adc`  
**Review branch:** `improvement/enterprise-ux-and-control-review`  
**Scope:** Inventory control, production planning, traceability, reporting, and enterprise UX.  
**Status:** Source review in progress. This document records verified findings from the baseline; it is not a production-readiness certification.

## Executive assessment

The project has substantial domain coverage and a meaningful PostgreSQL/Prisma foundation. It already contains physical-coil genealogy, contract allocation, inventory documents and ledger tables, production/WIP models, planning proposals, report configuration, and integration tests. The main risk is not a lack of features; it is uneven enforcement of the same business rules across legacy and newer API paths, combined with oversized UI/server modules and an information-dense navigation model.

Do not replace the application wholesale. Preserve the domain model and tested transactional paths, then converge all user workflows on those paths.

## Strengths

### 1. Domain coverage
- The Prisma schema contains dedicated entities for materials, parts, routes, route operations, machines/capabilities, dies/compatibilities, warehouses/locations, shifts, customers/orders, plans/proposals, manufacturing orders, production operations/reports/scrap/transfers, inventory documents/lines/transactions/reservations, stock balances, lots, contracts, physical coils, contract-coil allocations, and saved report configurations.
- The codebase separates major areas into inventory, planning, production/WIP, reporting, master data, and shared UI components.
- Jalali date utilities and Persian RTL styling are present.

### 2. Inventory controls
- A relational posting function exists in `inventoryEngine.ts` and writes inventory transactions and stock balances in a Prisma transaction.
- Inventory document workflows include draft, post, reverse, reservation, stock inquiry, ledger, contract, coil issue/return, and audit endpoints.
- Physical coil identity and contract allocations have dedicated relational models.
- Coil issue uses an idempotency key and a database uniqueness guard in the newer flow.

### 3. Production and WIP
- WIP snapshot persistence uses a version field and compare-and-swap update semantics.
- The newer production-posting path links WIP execution to relational manufacturing orders and production reports.
- The documented atomic production path posts good output, scrap, rework/rejected quantities, and stock movements in one PostgreSQL transaction.
- The application explicitly avoids requiring a second destination receipt confirmation for normal operation output in the newer atomic flow.

### 4. Planning and reporting
- Customer orders, relational net-requirement read model, versioned proposals, proposal approval/revision/release, and relational manufacturing-order creation exist.
- Reports cover stock movements, inventory reconciliation, WIP, aging, scrap, delays, workload/capacity, supplier/contract, and management metrics.
- Saved report configuration models and custom-report UI exist.
- CI provisions disposable PostgreSQL and runs schema, TypeScript, build, inventory, WIP, planning, report, and coil persistence tests.

## Weaknesses and risks

### A. Traceability and transaction consistency — Critical

**A1. Parallel legacy inventory endpoints remain active.**  
`GET /api/inventory/transactions`, `POST /api/inventory/validate-and-post`, and `POST /api/inventory/reverse` operate on process-local `transactionsStore`. The newer document workflow uses relational posting, but the legacy endpoints are still registered. If a UI path or integration calls the legacy endpoints, it can display or mutate a different ledger from PostgreSQL.

**Why this fails the criterion:** one business event can be represented differently depending on which endpoint was called. A traceability promise is only valid when every posting route reaches the same authoritative ledger.

**Required correction:** inventory mutations must use one application service and one relational transaction boundary. Legacy endpoints should be redirected to the canonical service or disabled with an explicit migration response; they must not silently accept memory-only postings.

**A2. Inventory application state is partly stored as a JSON snapshot.**  
`inventoryAppStateSnapshot` persists contracts, reservations, document cache, audit cache, and QC holds in a JSON payload, while several other entities are normalized in PostgreSQL.

**Why this matters:** snapshot state is harder to query, constrain, reconcile, and safely update across multiple server instances than normalized transactional records. A queued upsert is not a substitute for row-level concurrency controls on all business entities.

**Required correction:** migrate authoritative business records to relational tables incrementally. Keep JSON only for non-authoritative UI/cache state, with an explicit rebuild strategy.

**A3. WIP still has a transitional snapshot boundary.**  
The WIP state is persisted as a versioned JSON snapshot. The atomic production posting path has a documented optimistic concurrency guard, but the integration document explicitly states that not all in-memory stores are multi-instance safe.

**Required correction:** retain the tested atomic posting path, then progressively normalize MO operation queues, transfers, and execution state. Until complete, enforce single-writer/single-instance deployment or reject unsupported concurrent mutation paths.

### B. Inventory control — Critical / High

**B1. A legacy posting path does not call the relational posting service.**  
The old `validate-and-post` endpoint validates and prepends to the in-memory transaction array. It does not persist the posting to the relational stock ledger.

**B2. Some generic document data is assembled from client values and legacy stores before posting.**  
The document creation handler derives part details, weight, warehouse display data, and generated identifiers from process-local stores. The canonical relational post later validates balances, but the preparation layer should resolve all authoritative identities and conversions from PostgreSQL.

**B3. Coil receipt and generic material receipt are coupled through post-posting cache synchronization.**  
The generic receipt path creates/updates physical-coil cache records after the relational document posting. This is a fragile dual-write boundary: the document/stock transaction may commit while the subsequent snapshot update fails.

**Required correction:** create the physical coil, lot, contract allocations, document, ledger movements, and stock balances in one database transaction. Do not use a follow-up cache write as the only representation of a physical coil.

**B4. QC hold state has a client-side/local storage path as well as a server endpoint.**  
The stock inquiry UI applies QC hold overrides locally and persists the local map. This risks disagreement between browser state and authoritative available stock if any workflow bypasses the server-held status.

**Required correction:** QC hold/release must be a relational status/transaction with actor, timestamp, reason, and quantity; the UI must display the server result only.

### C. Production planning — High

**C1. Planning capability is ahead of finite-capacity scheduling.**  
The relational planning read model calculates demand netting, available stock/WIP, material shortage, and technically eligible machines. Its own documentation states that shift calendars, downtime, setup/load commitments, and existing assignments are not yet fully netted into a finite-capacity dispatch schedule.

**Why this matters:** an eligible machine is not necessarily available at the requested time.

**Required correction:** label machine results as eligible candidates until finite capacity is calculated. Add time-phased capacity buckets, setup duration, shift calendars, downtime, and existing commitments before calling a proposal a feasible schedule.

**C2. Planning UI and backend have had a staged migration.**  
The planning persistence document records a transition from legacy in-memory suggestion endpoints to relational proposals. Each planning screen/action must be checked against the current relational API; no sample-backed endpoint should be considered authoritative in database mode.

**Required correction:** map every planning UI action to a durable endpoint and test create → revise → approve → release → MO → WIP linkage end to end.

### D. UX/UI and information architecture — High

**D1. Navigation is information-dense.**  
The sidebar defines many detailed submodules and has `isFlatListMode = true`. It also contains role filtering, a show-all switch, menu search, dynamic database menus, and several levels of navigation. This increases the cognitive load for daily warehouse and production users.

**Required correction:** use a role-oriented Fiori-style navigation hierarchy with a small number of primary work areas, contextual actions, and progressive disclosure. Do not expose every technical function as a first-level destination.

**D2. Stock inquiry exposes too many columns by default.**  
The default visible column set enables part code/name, warehouse, lot, contract, ownership, physical quantity, available quantity, reserved quantity, and physical weight. For a high-volume table, this creates horizontal density and makes the key decision (what is available, where, and under which identity) harder to scan.

**Required correction:** default to a compact operational view (item, location, available quantity, unit/status). Put contract, ownership, lot/coil, weight, and detailed balances in a row detail panel or optional column chooser. Keep saved views for specialist roles.

**D3. Oversized components increase change risk.**  
Examples include `ErpProductionWorkbenchView.tsx` (~254 KB), `MasterDataHubView.tsx` (~161 KB), `MachinesView.tsx` (~91 KB), `StockInquiryView.tsx` (~98 KB), and `apiRouter.ts` (~529 KB). Large files mix presentation, state orchestration, domain decisions, and API handling.

**Required correction:** split by workflow and domain service, not by arbitrary line count. Keep screens thin; move table state, filters, data fetching, and business rules into focused hooks/services/components.

**D4. UI consistency needs a design system rather than multiple layout/theme modes.**  
The application exposes several ERP layout templates and themes. This flexibility is not inherently wrong, but it can produce inconsistent density, navigation, spacing, and interaction patterns.

**Required correction:** select one default enterprise interaction model inspired by SAP Fiori and Dynamics 365. Keep theme customization secondary; do not let it change the information architecture or task flow.

### E. Security and auditability — Critical

**E1. No Express API authentication/authorization middleware was found in the API router.**  
The router has a synchronization middleware, but the inspected server-side route stack does not verify Firebase ID tokens or enforce role/permission policies before accessing inventory and production endpoints. The repository's Firestore rules do not protect Express routes backed by PostgreSQL.

**Why this fails:** hiding a button or filtering the sidebar by role is not authorization. Direct HTTP requests can bypass frontend role presentation.

**Required correction:** verify Firebase ID tokens (or adopt a server-side session), map the authenticated identity to a relational user, and enforce permission checks per route/action. Do this before production use.

**E2. Legacy endpoints accept actor identity from request payload/default values.**  
For example, the legacy inventory posting endpoint accepts `createdByUid` and `createdByName` from the body and supplies fallback identities. Actor identity must come from verified authentication context, never from a client-controlled field.

**E3. JSON body limit is 50 MB.**  
This may be required for Excel import, but it is configured globally for all routes. Use a smaller global limit and a dedicated, validated upload route with its own limit and file checks.

## Four-criterion scorecard — Iteration 1

Scores are preliminary source-review ratings, not test pass rates.

| Criterion | Initial assessment | Reason |
|---|---:|---|
| End-to-end traceability | 2.5 / 5 | Strong relational and coil/WIP paths exist, but legacy memory-only routes and snapshot/cache boundaries remain. |
| Inventory correctness across raw/WIP/finished goods | 3 / 5 | Strong ledger foundation and atomic production slice; inconsistent legacy paths and QC/coil dual-write risks remain. |
| Reporting and user-built reports | 3.5 / 5 | Broad report coverage and saved report configurations exist; accuracy depends on canonical data paths and query scalability. |
| UX speed, clarity, low visual density | 2 / 5 | Many features, but flat/dense navigation, large default stock table, and oversized screens increase cognitive load. |

## Three-iteration remediation plan

### Iteration 1 — Establish correctness and UX baseline
1. Inventory all API endpoints and map each UI workflow to its endpoint and persistence mechanism.
2. Mark memory-only endpoints as legacy; remove them from active UI and fail closed in database mode.
3. Confirm stock-balance invariants and reconcile ledger totals against balances.
4. Add a route-level authorization design and close unauthenticated mutation paths.
5. Simplify the primary navigation and stock inquiry default density without changing business scenarios.

### Iteration 2 — Converge business workflows
1. Route receipts, issues, returns, transfers, adjustments, and QC holds through canonical relational services.
2. Make physical-coil receipt/issue/return/allocation a single atomic relational workflow.
3. Link all production reports, material consumption, scrap, WIP balances, and finished goods to immutable source documents.
4. Complete planning proposal → approval → release → MO → WIP linkage and define finite-capacity scheduling boundaries.
5. Build reconciliation and exception reports for missing links, negative balances, stale snapshots, and orphaned records.

### Iteration 3 — Enterprise UX, performance, and release
1. Apply one SAP Fiori / Dynamics 365-inspired information architecture and design system.
2. Use progressive disclosure, compact tables, column presets, saved filters, and contextual side panels.
3. Add server-side pagination, sorting, filtering, and query indexes for high-volume ledgers/reports.
4. Run end-to-end acceptance tests for coil, contract, raw material, WIP, scrap, finished goods, and customer delivery genealogy.
5. Run CI and staging regression tests; publish a release candidate and migration/rollback instructions.

## Non-negotiable acceptance rules

- No confirmed inventory mutation may exist only in process memory or browser storage.
- Every posted quantity must have a source document, actor, timestamp, location, item identity, unit, and applicable lot/coil/contract identity.
- A coil can be split by weight and allocated to multiple contracts without losing its physical identity.
- Material returns must restore the remaining physical coil/lot and preserve contract allocation genealogy.
- Production posting must reconcile input = good output + scrap + rework/rejected + explicitly documented variance.
- Good output moves automatically to the next route stage according to the approved workflow; do not add an unnecessary destination confirmation step.
- Finished-goods receipt/delivery must preserve MO, operation, material lot/coil, and customer-order genealogy.
- Reports must derive from authoritative PostgreSQL records and expose filters, saved views, and export where appropriate.
- Default screens must show only the information needed for the current task; details remain discoverable without being permanently visible.
- API authorization is enforced server-side for every sensitive operation.

## Baseline files inspected

- `prisma/schema.prisma`
- `src/server/apiRouter.ts`
- `src/server/inventoryEngine.ts`
- `src/server/productionWipEngine.ts`
- `src/server/relationalPlanningReadModel.ts`
- `src/components/Sidebar.tsx`
- `src/components/inventory/InventoryModuleView.tsx`
- `src/components/inventory/StockInquiryView.tsx`
- `src/components/Navbar.tsx`
- `src/index.css`
- `docs/ARCHITECTURE.md`
- `docs/WIP_INVENTORY_LEDGER_INTEGRATION.md`
- `docs/PLANNING_POSTGRESQL_PERSISTENCE.md`
- `security_spec.md`
- `.github/workflows/ci.yml`
