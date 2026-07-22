import { Router } from "express";
import { db, stockSnapshotsTable, productsTable, distributorsTable } from "@workspace/db";
import { eq, and, gte, ilike, inArray, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { classifyMovement } from "../lib/movement-classifier";

const router = Router();

// ---------------------------------------------------------------------------
// POST /experimental/cleanup-duplicates
// One-time admin-only operation: collapse per-warehouse duplicate rows that
// were committed before the aggregation fix was deployed.
//   - Exact-identical groups (same sellPrice+soh+soo): keep lowest id, delete rest.
//   - Differing groups: update lowest-id row with aggregated values
//     (SUM soh, SUM soo, MIN price; MAX price stored in sell_price_max when
//     spread >$1), then delete the rest.
// Idempotent — safe to call multiple times.
// ---------------------------------------------------------------------------
router.post("/experimental/cleanup-duplicates", requireAdmin, async (req, res) => {
  try {
    const result = await db.transaction(async (tx) => {
      // Step 1: Update the keep row of each DIFFERING group with aggregated values.
      // Exact-identical groups are intentionally excluded (distinct_combos = 1).
      await tx.execute(sql`
        WITH dupe_groups AS (
          SELECT
            distributor_id,
            product_id,
            snapshot_date,
            MIN(id)                                                   AS keep_id,
            COUNT(*)                                                  AS row_count,
            COUNT(DISTINCT CONCAT(
              COALESCE(sell_price::text, 'NULL'), '|',
              COALESCE(soh::text,        'NULL'), '|',
              COALESCE(soo::text,        'NULL')
            ))                                                        AS distinct_combos,
            SUM(COALESCE(soh, 0))                                     AS soh_sum,
            CASE WHEN bool_and(soo IS NULL)
              THEN NULL
              ELSE SUM(COALESCE(soo, 0))
            END                                                       AS soo_sum,
            MIN(sell_price)                                           AS min_price,
            MAX(sell_price)                                           AS max_price
          FROM stock_snapshots
          GROUP BY distributor_id, product_id, snapshot_date
          HAVING COUNT(*) > 1
        )
        UPDATE stock_snapshots ss
        SET
          soh           = dg.soh_sum,
          soo           = dg.soo_sum,
          sell_price    = dg.min_price,
          sell_price_max = CASE
            WHEN dg.max_price - dg.min_price > 1 THEN dg.max_price
            ELSE NULL
          END
        FROM dupe_groups dg
        WHERE ss.id      = dg.keep_id
          AND dg.distinct_combos > 1
      `);

      // Step 2: Delete all non-keep rows from both exact-identical and differing groups.
      const deleted = await tx.execute(sql`
        DELETE FROM stock_snapshots ss
        WHERE EXISTS (
          SELECT 1
          FROM (
            SELECT distributor_id, product_id, snapshot_date, MIN(id) AS keep_id
            FROM stock_snapshots
            GROUP BY distributor_id, product_id, snapshot_date
            HAVING COUNT(*) > 1
          ) dg
          WHERE dg.distributor_id = ss.distributor_id
            AND dg.product_id     = ss.product_id
            AND dg.snapshot_date  = ss.snapshot_date
            AND ss.id            != dg.keep_id
        )
        RETURNING ss.id
      `);

      // Step 3: Count outcomes for the response
      const stats = await tx.execute<{
        exact_identical: string;
        differing: string;
      }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE distinct_combos = 1) AS exact_identical,
          COUNT(*) FILTER (WHERE distinct_combos > 1) AS differing
        FROM (
          SELECT
            COUNT(DISTINCT CONCAT(
              COALESCE(sell_price::text, 'NULL'), '|',
              COALESCE(soh::text,        'NULL'), '|',
              COALESCE(soo::text,        'NULL')
            )) AS distinct_combos
          FROM stock_snapshots
          GROUP BY distributor_id, product_id, snapshot_date
          HAVING COUNT(*) > 1
        ) sub
      `);

      return {
        rowsDeleted: (deleted.rows ?? []).length,
        remainingDuplicateGroups: {
          exactIdentical: parseInt(String(stats.rows[0]?.exact_identical ?? "0"), 10),
          differing:      parseInt(String(stats.rows[0]?.differing      ?? "0"), 10),
        },
      };
    });

    req.log.info(result, "cleanup-duplicates completed");
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "cleanup-duplicates failed");
    res.status(500).json({ error: "Cleanup failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /experimental/movement
// Admin-only. Competitor market intelligence: see what competing distributors
// are selling so Dicker PMs can gauge whether to range the stock.
//
// Fixed 30-day look-back window. Weekly sell-through rate normalises by
// actual data span (daysCovered), not the window, so sparse feeds don't
// understate velocity.
//
// Query params:
//   distributorId      (required) integer
//   brand              string — filter to one canonical brand
//   search             string — VPN or description substring
//   activeOnly         (default true) boolean
//   excludeBundles     (default true) boolean — hide VPNs containing '_' or starting with 'CTO'
//   soldOutOnly        (default false) boolean
//   notCarriedByDicker (default false) boolean
//   sortBy             (default estWeeklyRevenue) enum
//   sortDir            (default desc) asc|desc
//   limit              (default 100, max 500) integer
//   offset             (default 0) integer
//
// Response: MovementResult — see openapi.yaml
// ---------------------------------------------------------------------------

// Fixed look-back window (days)
const WINDOW_DAYS = 30;

router.get("/experimental/movement", requireAdmin, async (req, res) => {
  const distId = parseInt(String(req.query.distributorId), 10);
  if (!distId || isNaN(distId)) {
    res.status(400).json({ error: "distributorId is required" });
    return;
  }

  const limit      = Math.min(500, Math.max(1, parseInt(String(req.query.limit  ?? "100"), 10) || 100));
  const offset     = Math.max(0, parseInt(String(req.query.offset ?? "0"),  10) || 0);
  const brand      = req.query.brand  ? String(req.query.brand).trim()  : null;
  const search     = req.query.search ? String(req.query.search).trim() : null;
  const activeOnly         = req.query.activeOnly         !== "false";
  const excludeBundles     = req.query.excludeBundles     !== "false";
  const soldOutOnly        = req.query.soldOutOnly        === "true";
  const notCarriedByDicker = req.query.notCarriedByDicker === "true";

  const validSortBy  = ["vpn", "brand", "desc", "soh", "price", "estWeeklyST", "estWeeklyRevenue"] as const;
  type SortByCol = typeof validSortBy[number];
  const sortByRaw    = String(req.query.sortBy ?? "estWeeklyRevenue");
  const sortBy: SortByCol = (validSortBy as readonly string[]).includes(sortByRaw) ? sortByRaw as SortByCol : "estWeeklyRevenue";
  const sortDir      = req.query.sortDir === "asc" ? "asc" : "desc";

  try {
    // Resolve distributor
    const [distributor] = await db
      .select({ id: distributorsTable.id, name: distributorsTable.name })
      .from(distributorsTable)
      .where(eq(distributorsTable.id, distId));

    if (!distributor) {
      res.status(404).json({ error: "Distributor not found" });
      return;
    }

    // Baseline distributor (Dicker Data) — for dickerStatus and notCarriedByDicker filter
    const [baseline] = await db
      .select({ id: distributorsTable.id })
      .from(distributorsTable)
      .where(eq(distributorsTable.isBaseline, true));
    const baselineDistId = baseline?.id ?? null;

    // Fixed 30-day look-back window
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Determine inference mode: does the latest snapshot have any nonzero SOO?
    const sooCheckRows = await db.execute<{ has_soo: boolean | string }>(sql`
      SELECT COUNT(*) > 0 AS has_soo
      FROM stock_snapshots
      WHERE distributor_id = ${distId}
        AND snapshot_date = (
          SELECT MAX(snapshot_date) FROM stock_snapshots WHERE distributor_id = ${distId}
        )
        AND soo IS NOT NULL AND soo > 0
    `);
    const hasSoo = sooCheckRows.rows[0]?.has_soo;
    const inferenceMode: "soo_aware" | "soh_only" =
      hasSoo === true || hasSoo === "true" ? "soo_aware" : "soh_only";

    // Data quality: snapshot dates in the window
    const dqRows = await db.execute<{ cnt: string; min_date: string | null; max_date: string | null }>(sql`
      SELECT COUNT(DISTINCT snapshot_date) AS cnt,
             MIN(snapshot_date)            AS min_date,
             MAX(snapshot_date)            AS max_date
      FROM stock_snapshots
      WHERE distributor_id = ${distId}
        AND snapshot_date >= ${cutoffStr}::date
    `);
    const dqRow = dqRows.rows[0];

    // Bundle/CTO exclusion count (always computed so PMs can sanity-check).
    // Primary signal: ss.sku_type = 'BundledItem' when the feed populates it (e.g. Dicker Data).
    // Fallback heuristic: vpn_display starts with 'CTO' OR contains a literal '_'.
    // STRPOS is used instead of LIKE because '_' is a wildcard in LIKE patterns.
    const bundleCountRows = await db.execute<{ excluded: string }>(sql`
      SELECT COUNT(DISTINCT ss.product_id) AS excluded
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      WHERE ss.distributor_id = ${distId}
        AND ss.snapshot_date >= ${cutoffStr}::date
        AND (
          CASE
            WHEN ss.sku_type IS NOT NULL AND ss.sku_type != ''
            THEN ss.sku_type = 'BundledItem'
            ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
          END
        )
    `);
    const bundlesExcluded = parseInt(String(bundleCountRows.rows[0]?.excluded ?? "0"), 10);

    const dataQuality = {
      snapshotCount: parseInt(String(dqRow?.cnt ?? "0"), 10),
      dateRange: { from: dqRow?.min_date ?? null, to: dqRow?.max_date ?? null },
      bundlesExcluded,
    };

    // --- SQL building blocks ---

    // Bundle/CTO exclusion filter.
    // Primary signal: ss.sku_type = 'BundledItem' (populated by Dicker Data and any future
    // distributor whose feed carries it). Fallback heuristic when sku_type is null: vpn_display
    // starts with 'CTO' OR contains a literal '_' (STRPOS, not LIKE, to avoid wildcard treatment).
    const bundleFilter = excludeBundles
      ? sql`AND NOT (
          CASE
            WHEN ss.sku_type IS NOT NULL AND ss.sku_type != ''
            THEN ss.sku_type = 'BundledItem'
            ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
          END
        )`
      : sql``;

    // FIX 2: activeOnly includes sold-out products that had movement in the window
    const activeFilter = activeOnly
      ? sql`AND ss.product_id IN (
          SELECT product_id FROM stock_snapshots
          WHERE distributor_id = ${distId}
            AND snapshot_date >= ${cutoffStr}::date
          GROUP BY product_id
          HAVING
            BOOL_OR(soh > 0)
            OR BOOL_OR(soo > 0)
            OR MIN(COALESCE(soh, 0)) != MAX(COALESCE(soh, 0))
        )`
      : sql``;

    // estUnitsSold SQL formula — mirrors classifyMovement() exactly.
    // Defined as a plain string so it can be safely embedded into both the
    // SELECT expression (via sql.raw) and the soldOutOnly HAVING clause string
    // without using queryChunks, which are internal Drizzle objects and produce
    // invalid SQL when joined.
    const EST_UNITS_SOLD_SQL = `COALESCE(SUM(
      CASE
        WHEN soh - prev_soh < 0 THEN -(soh - prev_soh)
        WHEN soh - prev_soh > 0
          AND (COALESCE(soo, 0) - COALESCE(prev_soo, 0)) < 0
          THEN GREATEST(0, -(COALESCE(soo, 0) - COALESCE(prev_soo, 0)) - (soh - prev_soh))
        ELSE 0
      END
    ) FILTER (WHERE prev_soh IS NOT NULL AND soh IS NOT NULL), 0)`;

    const estUnitsSoldExpr = sql.raw(EST_UNITS_SOLD_SQL);

    // soldOutOnly post-aggregation HAVING condition
    const soldOutHaving = soldOutOnly
      ? sql.raw(`AND MAX(soh) FILTER (WHERE rn = 1) = 0 AND ${EST_UNITS_SOLD_SQL} > 0`)
      : sql``;

    // notCarriedByDicker post-aggregation WHERE condition
    const notCarriedFilter =
      notCarriedByDicker && baselineDistId != null
        ? sql`AND product_id NOT IN (
            SELECT DISTINCT product_id FROM stock_snapshots
            WHERE distributor_id = ${baselineDistId}
          )`
        : sql``;

    // --- Count query (same filter stack as paginated query for accurate totals) ---
    const countRows = await db.execute<{ total: string }>(sql`
      WITH ordered AS (
        SELECT
          ss.product_id,
          ss.soh,
          ss.soo,
          LAG(ss.soh) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soh,
          LAG(ss.soo) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soo,
          ROW_NUMBER() OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date DESC) AS rn
        FROM stock_snapshots ss
        JOIN products p ON p.id = ss.product_id
        WHERE ss.distributor_id = ${distId}
          AND ss.snapshot_date >= ${cutoffStr}::date
          ${activeFilter}
          ${bundleFilter}
          ${brand  ? sql`AND p.brand = ${brand}` : sql``}
          ${search ? sql`AND (p.vpn_normalized ILIKE ${"%" + search + "%"} OR p.description ILIKE ${"%" + search + "%"})` : sql``}
      ),
      agg AS (
        SELECT
          product_id,
          MAX(soh) FILTER (WHERE rn = 1) AS latest_soh,
          ${estUnitsSoldExpr}             AS est_units_sold
        FROM ordered
        GROUP BY product_id
        HAVING 1=1 ${soldOutHaving}
      )
      SELECT COUNT(*) AS total FROM agg WHERE 1=1 ${notCarriedFilter}
    `);
    const total = parseInt(String(countRows.rows[0]?.total ?? "0"), 10);

    // --- Sort expression (sql.raw so column/direction aren't parameterized) ---
    const sortColName =
      sortBy === "soh"              ? "agg.latest_soh"
      : sortBy === "price"          ? "agg.latest_price"
      : sortBy === "estWeeklyST"    ? "agg.est_weekly_st"
      : sortBy === "estWeeklyRevenue" ? "agg.est_weekly_revenue"
      : sortBy === "vpn"            ? "p.vpn_normalized"
      : sortBy === "brand"          ? "p.brand"
      :                               "p.description";
    const orderByClause = sql.raw(`${sortColName} ${sortDir === "asc" ? "ASC" : "DESC"} NULLS LAST`);

    // --- Paginated product list ---
    // CTE computes estUnitsSold, weekly sell-through rate (normalised by actual
    // daysCovered, not window), sorts, then paginates.
    // FIX 1: sort order preserved — client iterates productIds[] in CTE order.
    const productIdRows = await db.execute<{ product_id: string }>(sql`
      WITH ordered AS (
        SELECT
          ss.product_id,
          ss.soh,
          ss.soo,
          ss.sell_price,
          ss.snapshot_date,
          LAG(ss.soh) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soh,
          LAG(ss.soo) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soo,
          ROW_NUMBER() OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date DESC) AS rn
        FROM stock_snapshots ss
        JOIN products p ON p.id = ss.product_id
        WHERE ss.distributor_id = ${distId}
          AND ss.snapshot_date >= ${cutoffStr}::date
          ${activeFilter}
          ${bundleFilter}
          ${brand  ? sql`AND p.brand = ${brand}` : sql``}
          ${search ? sql`AND (p.vpn_normalized ILIKE ${"%" + search + "%"} OR p.description ILIKE ${"%" + search + "%"})` : sql``}
      ),
      agg AS (
        SELECT
          product_id,
          COUNT(*)                        AS snap_count,
          MAX(soh)        FILTER (WHERE rn = 1) AS latest_soh,
          MAX(sell_price) FILTER (WHERE rn = 1) AS latest_price,
          MAX(snapshot_date) - MIN(snapshot_date) AS days_covered,
          ${estUnitsSoldExpr}             AS est_units_sold,
          CASE
            WHEN COUNT(*) >= 2
              AND (MAX(snapshot_date) - MIN(snapshot_date)) >= 7
            THEN ${estUnitsSoldExpr} * 7.0
                 / GREATEST(1, MAX(snapshot_date) - MIN(snapshot_date))
            ELSE NULL
          END AS est_weekly_st,
          CASE
            WHEN COUNT(*) >= 2
              AND (MAX(snapshot_date) - MIN(snapshot_date)) >= 7
            THEN ${estUnitsSoldExpr} * 7.0
                 / GREATEST(1, MAX(snapshot_date) - MIN(snapshot_date))
                 * MAX(sell_price) FILTER (WHERE rn = 1)
            ELSE NULL
          END AS est_weekly_revenue
        FROM ordered
        GROUP BY product_id
        HAVING 1=1 ${soldOutHaving}
      )
      SELECT agg.product_id
      FROM agg
      JOIN products p ON p.id = agg.product_id
      WHERE 1=1 ${notCarriedFilter}
      ORDER BY ${orderByClause}
      LIMIT ${limit} OFFSET ${offset}
    `);
    const productIds = productIdRows.rows.map((r) => parseInt(String(r.product_id), 10));

    if (productIds.length === 0) {
      res.json({
        distributorId:   distId,
        distributorName: distributor.name,
        inferenceMode,
        dataQuality,
        products: [],
        total,
        limit,
        offset,
      });
      return;
    }

    // Fetch all in-window snapshots for the paginated products (for sparkline + classifier)
    type SnapshotRow = {
      product_id:     string;
      vpn_normalized: string;
      vpn_display:    string;
      brand:          string;
      description:    string;
      snapshot_date:  string;
      soh:            string | null;
      soo:            string | null;
      sell_price:     string | null;
      sell_price_max: string | null;
    };

    const snapshotRows = await db.execute<SnapshotRow>(sql`
      SELECT
        ss.product_id,
        p.vpn_normalized,
        p.vpn_display,
        p.brand,
        p.description,
        ss.snapshot_date,
        ss.soh,
        ss.soo,
        ss.sell_price,
        ss.sell_price_max
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      WHERE ss.distributor_id = ${distId}
        AND ss.snapshot_date >= ${cutoffStr}::date
        AND ss.product_id = ANY(${sql`ARRAY[${sql.join(productIds.map((id) => sql`${id}`), sql`, `)}]::int[]`})
      ORDER BY ss.product_id, ss.snapshot_date ASC
    `);

    // Dicker Data latest SOH per product in this page (for dickerStatus)
    type DickerRow = { product_id: string; latest_soh: string | null };
    const dickerRows = baselineDistId != null
      ? await db.execute<DickerRow>(sql`
          SELECT DISTINCT ON (product_id)
            product_id, soh AS latest_soh
          FROM stock_snapshots
          WHERE distributor_id = ${baselineDistId}
            AND product_id = ANY(${sql`ARRAY[${sql.join(productIds.map((id) => sql`${id}`), sql`, `)}]::int[]`})
          ORDER BY product_id, snapshot_date DESC
        `)
      : { rows: [] as DickerRow[] };
    const dickerByProduct = new Map(
      dickerRows.rows.map((r) => [parseInt(String(r.product_id), 10), r.latest_soh]),
    );

    // Group snapshots by product
    const byProduct = new Map<number, SnapshotRow[]>();
    for (const row of snapshotRows.rows) {
      const pid = parseInt(String(row.product_id), 10);
      const group = byProduct.get(pid);
      if (group) group.push(row);
      else byProduct.set(pid, [row]);
    }

    // FIX 1: iterate productIds in CTE sort order (not Map insertion order)
    const products = productIds
      .filter((pid) => byProduct.has(pid))
      .map((pid) => {
        const sorted = byProduct.get(pid)!; // ASC by snapshot_date from DB
        const latest = sorted[sorted.length - 1]!;

        const latestSoh  = latest.soh       != null ? parseInt(String(latest.soh), 10) : null;
        const latestSell = latest.sell_price != null ? parseFloat(latest.sell_price)   : null;

        const snapshotCount = sorted.length;
        const firstDate = sorted[0]!.snapshot_date;
        const lastDate  = sorted[snapshotCount - 1]!.snapshot_date;
        const daysCovered = Math.round(
          (new Date(lastDate).getTime() - new Date(firstDate).getTime()) / 86_400_000,
        );

        // Classifier: lower-bound estimate of units sold by this competitor
        const { estUnitsSold } = classifyMovement(
          sorted.map((s) => ({
            soh: s.soh != null ? parseInt(String(s.soh), 10) : null,
            soo: s.soo != null ? parseInt(String(s.soo), 10) : null,
          })),
        );

        // Weekly sell-through: normalised by actual data span, not window.
        // Null when daysCovered < 7 or fewer than 2 snapshots (insufficient data).
        const estWeeklyST =
          snapshotCount >= 2 && daysCovered >= 7
            ? Math.round((estUnitsSold / daysCovered) * 7 * 10) / 10
            : null;

        const estWeeklyRevenue =
          estWeeklyST != null && latestSell != null
            ? Math.round(estWeeklyST * latestSell * 100) / 100
            : null;

        const soldOut = latestSoh === 0 && estUnitsSold > 0;

        // Dicker status: stocked / listed / not carried
        const dickerLatestSoh = dickerByProduct.get(pid);
        const dickerStatus: "stocked" | "listed" | "not carried" =
          dickerLatestSoh === undefined
            ? "not carried"
            : dickerLatestSoh != null && parseInt(String(dickerLatestSoh), 10) > 0
            ? "stocked"
            : "listed";

        return {
          productId:       pid,
          vpnNormalized:   latest.vpn_normalized,
          vpnDisplay:      latest.vpn_display,
          brand:           latest.brand,
          description:     latest.description,
          snapshots:       sorted.map((s) => ({
            snapshotDate: s.snapshot_date,
            soh:          s.soh       != null ? parseInt(String(s.soh), 10) : null,
            soo:          s.soo       != null ? parseInt(String(s.soo), 10) : null,
            sellPrice:    s.sell_price != null ? parseFloat(s.sell_price)   : null,
          })),
          latestSoh,
          latestSellPrice: latestSell,
          snapshotCount,
          daysCovered,
          estUnitsSold,
          estWeeklyST,
          estWeeklyRevenue,
          soldOut,
          dickerStatus,
        };
      });

    res.json({
      distributorId:   distId,
      distributorName: distributor.name,
      inferenceMode,
      dataQuality,
      products,
      total,
      limit,
      offset,
    });
  } catch (err) {
    req.log.error({ err }, "movement query failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
