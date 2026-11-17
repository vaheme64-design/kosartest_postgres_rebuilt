# Inventory UX Redesign — Iteration 2

## Scope

This iteration improves the inventory workspace without changing its business rules, document lifecycle, material ownership model, coil allocation logic, or production/WIP process.

## Implemented interaction model

- Persistent inventory navigation remains available beside the active work area.
- The selected module now has a contextual page header with a breadcrumb, page title, and task-oriented description.
- The action toolbar follows a Fiori-style hierarchy:
  - Primary actions remain visible: receive stock, issue to production, and deliver finished goods to a customer.
  - Less frequent actions are grouped under **Other operations**: operation material issue, production return, warehouse transfer, and stock adjustment.
- The overflow control exposes its expanded state to assistive technology and closes after an action is selected.
- Existing module navigation, deep links, modal workflows, and refresh callbacks are retained.

## Stock inquiry interaction model retained

The stock inquiry continues to separate three user tasks:

1. Part-centric stock and Cardex.
2. Analytical, filterable inventory list.
3. Coil slitting genealogy.

The existing server-side filtering, pagination, grouped totals, drill-down detail pages, selected-part Cardex, column preferences, and CSV export remain the data-access foundation. Advanced traceability filters are progressively disclosed rather than permanently occupying the primary filter area.

## Regression coverage added

- Atomic WIP production now verifies both the intermediate-stage transfer and final-stage posting to LOC-FIN-P1.
- The WIP test verifies good quantity, scrap quantity, source depletion, destination balances, ledger movements, idempotent replay, and rejection when source stock is insufficient.
- The HTTP inventory lifecycle test verifies physical coil receipt, contract allocation, issue, partial return, concurrent return protection, finished-goods receipt, and customer delivery.
- Customer delivery is checked for a persisted customer reference, a negative PostgreSQL ledger movement, and the expected net finished-goods balance.
- Test-created documents and balances are cleaned up or restored.

## Verification

The branch CI run **#266** completed successfully. It passed TypeScript validation, production build, Prisma schema validation, seed checks, inventory regression tests, WIP reconciliation, atomic WIP production, planning, customer-order, reporting, physical-coil, inventory HTTP lifecycle, and first-operation coil-to-WIP integration tests.

Run: https://github.com/vaheme64-design/kosartest_postgres_rebuilt/actions/runs/44040718059

## Acceptance still required

CI success does not replace a visual and operational acceptance session with the actual factory users and production database. Before release, verify the new toolbar and navigation at the factory's target screen sizes, confirm user-role visibility, and run representative real-data scenarios. The redesign is limited to the inventory workspace in this iteration; it is not a claim that every application module has been redesigned to SAP Fiori parity.