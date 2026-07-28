---
name: DistiBench upload commit hardening
description: Upload pipeline invariants, status values, and freshness anchor pattern after the July 2026 hardening work.
---

## Upload status values
`parsing` → `committed` (success) | `failed_empty` (0 rows matched brands) | `superseded` (replaced by later upload for same distributor+date) | `invalid_mapping` (manually purged) | `failed` (legacy).

Status column is plain `text` — no PostgreSQL check constraint; adding new values requires only Drizzle schema update + TS rebuild.

## commitRowsBatched transaction order
1. `UPDATE uploads SET status='superseded' WHERE distributor_id=$distId AND snapshot_date=$date AND status='committed'` — must fire BEFORE the DELETE so prior upload flips before losing its rows.
2. `DELETE FROM stock_snapshots WHERE distributor_id=$distId AND snapshot_date=$date`
3. Batch insert new snapshots.
New upload has `status='parsing'` at this point, so the UPDATE only touches prior committed uploads.

## Empty commit detection
Both commit endpoints (`/uploads/commit` and `/uploads/commit-direct`) check `if (committed === 0)` after `commitRowsBatched`. On zero: set `status='failed_empty'`, return 422 with `{ error: "No rows matched tracked brands — nothing was imported." }`.

## Freshness anchor pattern (4 locations)
All four anchor sites add `AND EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.upload_id = uploads.id)` to exclude committed uploads with zero rows.
- `comparison.ts` → `distributor_current_dates` CTE
- `insights.ts` → `current_upload` CTE (in `buildSharedCtes()`)
- `experimental.ts` → `dickerLatestUpload` Drizzle query (uses `sql\`EXISTS...\``)
- `compare-file.ts` → `freshnessResult` SQL query

**Why:** A committed upload with 0 snapshot rows (e.g. superseded before the fix, or brand-filtered) could otherwise become the anchor date and make all snapshots appear stale.

## freshnessWarnings API field
`GET /api/comparison` response includes `freshnessWarnings: Array<{ distributorId, distributorName, latestUploadDate, fallbackDate }>`. Non-empty when the newest committed upload for a distributor has no rows and the anchor fell back. Comparison page renders yellow dismissible banner per entry.

## Purge endpoint
`POST /api/admin/maintenance/purge-upload` gated on `ENABLE_MAINTENANCE_PURGE=true`. Returns 403 when not set. `GET /api/admin/maintenance/purge-status` returns `{ enabled: boolean }` for UI show/hide. Settings → Users hides the DatabaseMaintenance section when disabled.

**Backup tables:** Created BEFORE DELETE inside transaction: `stock_snapshots_purge_backup_{id}_{yyyymmddhhmm}` and `products_purge_backup_{id}_{yyyymmddhhmm}`. Both persist after commit. Response includes `result.backupTables`.

## One-time production migration (startup)
`migrate-superseded-backfill.ts` runs on production startup. Quick-check: if any of uploads 48/67/71 are still `committed`, runs UPDATE + TRUNCATE market_price_cache. Becomes no-op after first run.
