# DistiBench — Distributor Pricing & Stock Comparison

A web application for product managers at an IT distributor to benchmark pricing and stock against competing distributors.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at /api)
- `pnpm --filter @workspace/app run dev` — run the frontend (port 23863, served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — session signing secret
- Optional env: `ENABLE_MAINTENANCE_PURGE` — see Database Maintenance below

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, shadcn/ui, wouter routing, TanStack Query
- API: Express 5 with express-session + connect-pg-simple
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- File parsing: SheetJS (`xlsx`) + multer (uploads), Papa Parse (Phase 2)
- API codegen: Orval (from OpenAPI spec)
- Auth: email/password with server-side sessions (bcryptjs)
- Grid: AG Grid Community (Phase 3)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Drizzle table definitions (one file per table)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/lib/` — shared server utilities (vpn.ts, brands.ts)
- `artifacts/api-server/uploads/` — temp file storage for import pipeline
- `artifacts/app/src/` — React frontend

## Architecture decisions

- All data ingestion goes through a single `ImportSource` interface (parse → preview → commit) so future automated feeds drop in without reworking the pipeline.
- VPN normalization: trim + uppercase + collapse whitespace. Dashes preserved. Single function `normalizeVpn()` — easy to change.
- Brand matching is alias-based via DB table `brands` (editable in UI). Case+whitespace insensitive.
- Movement is computed on read (v1) by ordering `stock_snapshots` for a given product+distributor by `snapshot_date` and diffing latest vs previous SOH.
- Baseline distributor (Dicker Data) is flagged via `is_baseline = true`. Exactly one at a time enforced in the POST/PATCH distributor routes.
- Sessions stored in Postgres (`user_sessions` table, created automatically by connect-pg-simple).

## Product

### Phase 1 — Done
- Email/password auth with server-side sessions
- Dashboard landing with distributor freshness cards
- Settings: Distributors (create/edit/delete/set-baseline)
- Settings: Brands (manage 8 canonical brands + aliases)

### Phase 2 — Next
- Upload flow: file parse → column mapping UI → brand filter → preview → commit
- Per-distributor import profiles (auto-apply saved mapping on next upload)

### Phase 3 — Planned
- AG Grid comparison view (one row per VPN, grouped columns per distributor)
- vs-Dicker price delta columns, cheapest competitor, "Dicker is most expensive" flag

### Phase 4 — Planned
- SOH movement column: `+200 (since 26.06.2026)` or `NEW`

### Phase 5 — Planned
- Dashboard tiles + freshness polish
- Brand aliases settings page polish

## Domain glossary

- **VPN** — vendor part number (cross-distributor match key)
- **SOH** — stock on hand
- **SOO** — stock on order (optional/nullable)
- **Sell price** — the comparison price (not cost, not RRP)
- **Baseline** — Dicker Data (our own distributor)
- **Snapshot** — one uploaded file = one point-in-time dataset for a distributor

## Seed / demo data

- Admin user: `amir.kalil@dickerdata.com.au` / (see Replit Secrets — not stored in plaintext)
- Baseline distributor: Dicker Data (is_baseline = true)
- 8 tracked brands pre-seeded with aliases: SAMSUNG, DELL, APC, TP LINK, NETGEAR, SEAGATE, ASUS, LENOVO

## User preferences

- Dense enterprise ERP aesthetic (Pronto Xi feel), not consumer SaaS
- Monospace for all part numbers, prices, quantities
- Date format: DD.MM.YYYY throughout
- Zebra striping on tables, compact row heights
- No emojis in UI

## Database Maintenance

### Purge endpoint (`POST /api/admin/maintenance/purge-upload`)

This endpoint permanently deletes all stock snapshots for a given upload ID, removes any products that become fully orphaned, and marks the upload `invalid_mapping`. It is **disabled by default** in all environments.

**To enable:**
1. Set `ENABLE_MAINTENANCE_PURGE=true` in Replit Secrets (Settings → Secrets).
2. The "Database Maintenance" section will appear in Settings → Users for admin accounts.
3. Always run Dry Run first to confirm impact before committing the purge.
4. **Disable immediately after use** — remove or set `ENABLE_MAINTENANCE_PURGE=false`. The section disappears from the UI and the route returns 403.

The endpoint creates two point-in-time backup tables before deleting anything:
- `stock_snapshots_purge_backup_{uploadId}_{yyyymmddhhmm}`
- `products_purge_backup_{uploadId}_{yyyymmddhhmm}`

Both tables persist after the purge and must be dropped manually once recovery is no longer needed.

### Upload status values

| Status | Meaning |
|---|---|
| `parsing` | Upload record created; commit in progress |
| `committed` | Successfully committed; snapshot rows are live |
| `superseded` | A later upload for the same distributor+date replaced this one's rows |
| `failed_empty` | Commit completed but zero rows matched tracked brands |
| `failed` | Legacy failure status |
| `invalid_mapping` | Manually invalidated via purge endpoint |

## Gotchas

- After adding new schema files to `lib/db/src/schema/`, run `pnpm run typecheck:libs` before typechecking artifacts — stale lib declarations cause false-positive TS2305 errors.
- `pnpm --filter @workspace/db run push` must be run after any schema changes before the API server will work correctly.
- The brand alias matching is case+whitespace insensitive. Canonical names are stored UPPERCASE in the DB.
- `connect-pg-simple` creates the `user_sessions` table automatically on first startup (`createTableIfMissing: true`).
- The uploads `status` column is plain `text` (no PostgreSQL check constraint) — new status values require only a Drizzle schema update and TypeScript rebuild, not a DB migration.
- The freshness anchor in `comparison.ts`, `insights.ts`, `experimental.ts`, and `compare-file.ts` uses `AND EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.upload_id = uploads.id)` to exclude empty committed uploads from the current-date calculation. The comparison endpoint returns `freshnessWarnings` when this fallback is triggered.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
