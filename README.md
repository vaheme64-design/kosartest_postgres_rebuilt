# Kosar Sanat Abrar — Rebuilt

This repository is the clean working copy of `vaheme64-design/kosartest_postgres`.

The initial source snapshot is being reviewed before application files are copied. Local SQLite databases and generated build artifacts are intentionally excluded; PostgreSQL is the target database.


## Rebuild validation

The active repair work is tracked in the draft pull request. CI validates the Prisma schema, TypeScript, production build, and automated test suites. The PostgreSQL schema must be synchronized with `bun run db:push` before first startup; seed canonical master data with `bun run seed` only for a new database.
