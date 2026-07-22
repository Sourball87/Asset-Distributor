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
Sessions stored in Postgres via `connect-pg-simple` with `createTableIfMissing: true`. Table: `user_sessions`. Secret from `SESSION_SECRET` env var. `trust proxy: 1` set in Express app. `credentials: 'include'` set globally in `customFetch`. Auth context only clears user on initial check — background refetch errors do not log user out.

## Import pipeline seam
Parse → Preview → Commit is a 3-step flow. `ParseUpload` writes to `artifacts/api-server/uploads/` (temp file). `CommitUpload` reads the temp file by `tempFileKey`. This makes automated feeds easy to add — just skip the file upload step and call Commit directly.

## CSV parsing — csv-parse required
Server uses `csv-parse/sync` for all delimited files (comma and tab). The naive `split(delimiter)` approach breaks on Leader Systems files because their LONG DESCRIPTION field contains HTML with embedded commas and newlines (multi-line quoted CSV fields). `csv-parse` handles this correctly.

**Why:** Leader's export has RFC 4180 quoted multi-line fields. Simple split breaks them.

**How to apply:** Any future changes to `parseDelimited()` in `artifacts/api-server/src/routes/uploads.ts` must keep `csv-parse/sync` for correctness.

## Commit source format — no "csv" enum
`CommitUploadInputSourceFormat` only has `xlsx` and `txt`. CSV files are committed as `txt` format with the delimiter passed separately. The backend doesn't distinguish CSV from TXT in parsing — it uses the `delimiter` param regardless of `sourceFormat`.

## Known distributor file formats
- Ingram Micro: comma CSV (.TXT ext), VPN=`Vendor Part Number`, Brand=`Vendor Name`, Price=`Customer Price`, SOH=`Available Quantity`, SOO=`Backlog Information`
- Leader Systems: quoted comma CSV (.csv ext), VPN=`MANUFACTURER SKU`, Brand=`MANUFACTURER`, Price=`DBP`, SOH=`AT` (has ">20" / "CALL" values → treated as numeric or null)
- Synnex: tab-separated (.txt ext), VPN=`MANUFACTURER_PART_NUMBER`, Brand=`MANUFACTURER_NAME`, Price=`RESELLER_BUY_EX`, SOH=`TOTAL_AVAILABILITY`

## Per-warehouse duplicate aggregation (commitRowsBatched)
Some distributors (Dicker Data, Ingram) ship one row per warehouse for the same VPN. Aggregation rule: group by `vpnNormalized` within a single import; if all rows in the group are identical on (sellPrice, soh, soo) → keep ONE unchanged (no summing); otherwise SUM soh (null-safe), SUM soo (null as 0; null only if all null), MIN sell_price. When non-null prices differ by >$1, persist MAX in `sell_price_max` column (leading indicator for PMs) and log WARN.

**Why:** Without this, exact-duplicate warehouse rows (Dicker) would double-count stock. Different warehouse rows (Ingram SOH+SOO split) need summing.

**How to apply:** The aggregation is inside `commitRowsBatched()` in `artifacts/api-server/src/routes/uploads.ts`, step 2. The `sell_price_max` column on `stock_snapshots` stores the spread signal for the Stage 2 movement API.

## Stage 2 movement API
`GET /api/experimental/movement` — admin-only, params: distributorId (required), days (default 14), brand, search, limit, offset. Auto-detects `inferenceMode`: `soo_aware` if latest snapshot has any nonzero SOO, else `soh_only`. Returns per-product daily series + movement (latest SOH − previous SOH) + `priceSpreadFlag` from `sell_price_max`.

One-time cleanup endpoint: `POST /api/experimental/cleanup-duplicates` — collapses pre-existing warehouse duplicate rows using the same aggregation rule. Idempotent.

**Production deploy order:** (1) push schema (add `sell_price_max` column), (2) deploy code, (3) POST to `/api/experimental/cleanup-duplicates` once as admin.

## Movement computation
Computed on read (v1) by ordering `stock_snapshots` for product+distributor by `snapshot_date` DESC and diffing `[0].soh - [1].soh`. Materialize only if performance requires it.

## Seed credentials / distributors
- Admin: `admin@dickerdata.com.au` / `admin`
- Distributors: Dicker Data (id=1, baseline), Ingram Micro (id=2), Leader Systems (id=3), Synnex (id=4)
- If distributors table is empty, re-seed from replit.md values
