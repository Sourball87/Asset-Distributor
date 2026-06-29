---
name: DistiBench schema decisions
description: Key architecture and schema decisions for the Distributor Pricing & Stock Comparison tool (DistiBench).
---

## VPN normalization
Rule: trim + uppercase + collapse internal whitespace. Dashes preserved (significant in part numbers). Single function `normalizeVpn()` in `artifacts/api-server/src/lib/vpn.ts`.

**Why:** Part numbers like `WD-1234` and `WD 1234` should NOT be treated as the same — dashes are meaningful in distributor catalogs.

**How to apply:** All ingestion paths call `normalizeVpn()` before upsert into `products.vpn_normalized`. The display value (`vpn_display`) stores the original.

## Brand alias matching
Alias map lives in the `brands` DB table (editable UI). Matching is case+whitespace insensitive. Canonical names stored UPPERCASE. Helper in `artifacts/api-server/src/lib/brands.ts`.

**Why:** Distributors label the same brand inconsistently (TP-LINK vs TP LINK vs TPLINK). The alias table is user-editable so PMs can add new spellings without a code change.

## Baseline distributor enforcement
`is_baseline` is set on one distributor at a time. POST and PATCH distributor routes unset existing baseline before setting the new one.

**Why:** Comparison logic assumes exactly one baseline (Dicker Data). Multiple baselines would break price delta calculations.

## Session storage
Sessions stored in Postgres via `connect-pg-simple` with `createTableIfMissing: true`. Table: `user_sessions`. Secret from `SESSION_SECRET` env var.

## Import pipeline seam
Parse → Preview → Commit is a 3-step flow. `ParseUpload` writes to `artifacts/api-server/uploads/` (temp file). `CommitUpload` reads the temp file by `tempFileKey`. This makes automated feeds easy to add — just skip the file upload step and call Commit directly.

## Movement computation
Computed on read (v1) by ordering `stock_snapshots` for product+distributor by `snapshot_date` DESC and diffing `[0].soh - [1].soh`. Materialize only if performance requires it.

## Seed credentials
Admin: `admin@dickerdata.com` / `admin`. Hash was generated with bcryptjs 10 rounds from `artifacts/api-server` dir.
