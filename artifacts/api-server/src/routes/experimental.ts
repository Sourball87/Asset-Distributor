import { Router } from "express";
import { db, stockSnapshotsTable, productsTable, distributorsTable } from "@workspace/db";
import { eq, and, gte, ilike, inArray, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

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
// Admin-only. Stock movement analysis for a single distributor.
//
// Query params:
//   distributorId  (required) integer
//   days           (default 14) integer — look-back window
//   brand          string — filter to one canonical brand
//   search         string — VPN or description substring (case-insensitive)
//   limit          (default 100) integer
//   offset         (default 0)  integer
//
// Response: MovementResult — see openapi.yaml
// ---------------------------------------------------------------------------
router.get("/experimental/movement", requireAdmin, async (req, res) => {
  const distId = parseInt(String(req.query.distributorId), 10);
  if (!distId || isNaN(distId)) {
    res.status(400).json({ error: "distributorId is required" });
    return;
  }

  const days       = Math.max(1, parseInt(String(req.query.days   ?? "14"), 10) || 14);
  const limit      = Math.min(500, Math.max(1, parseInt(String(req.query.limit  ?? "100"), 10) || 100));
  const offset     = Math.max(0, parseInt(String(req.query.offset ?? "0"),  10) || 0);
  const brand      = req.query.brand  ? String(req.query.brand).trim()  : null;
  const search     = req.query.search ? String(req.query.search).trim() : null;
  const activeOnly = req.query.activeOnly !== "false";

  try {
    // Resolve distributor name
    const [distributor] = await db
      .select({ id: distributorsTable.id, name: distributorsTable.name })
      .from(distributorsTable)
      .where(eq(distributorsTable.id, distId));

    if (!distributor) {
      res.status(404).json({ error: "Distributor not found" });
      return;
    }

    // Cutoff date (days look-back from today)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Determine inference mode: does the latest snapshot have any nonzero SOO?
    const sooCheckRows = await db.execute<{ has_soo: string }>(sql`
      SELECT COUNT(*) > 0 AS has_soo
      FROM stock_snapshots
      WHERE distributor_id = ${distId}
        AND snapshot_date = (
          SELECT MAX(snapshot_date) FROM stock_snapshots WHERE distributor_id = ${distId}
        )
        AND soo IS NOT NULL AND soo > 0
    `);
    const inferenceMode: "soo_aware" | "soh_only" =
      sooCheckRows.rows[0]?.has_soo === "true" ? "soo_aware" : "soh_only";

    // Data quality: snapshot dates available in the window
    const dqRows = await db.execute<{ cnt: string; min_date: string | null; max_date: string | null }>(sql`
      SELECT COUNT(DISTINCT snapshot_date) AS cnt,
             MIN(snapshot_date)            AS min_date,
             MAX(snapshot_date)            AS max_date
      FROM stock_snapshots
      WHERE distributor_id = ${distId}
        AND snapshot_date >= ${cutoffStr}::date
    `);
    const dqRow  = dqRows.rows[0];
    const dataQuality = {
      snapshotCount: parseInt(String(dqRow?.cnt ?? "0"), 10),
      dateRange: {
        from: dqRow?.min_date ?? null,
        to:   dqRow?.max_date ?? null,
      },
    };

    // Build WHERE conditions for the product filter
    const brandCondition  = brand  ? eq(productsTable.brand, brand)                                   : undefined;
    const searchCondition = search ? sql`(${productsTable.vpnNormalized} ILIKE ${"%" + search + "%"} OR ${productsTable.description} ILIKE ${"%" + search + "%"})` : undefined;

    // When activeOnly=true, restrict to products that have at least one snapshot
    // in the window with SOH > 0 or SOO > 0 (filters out catalogue-only lines).
    const activeFilter = activeOnly
      ? sql`AND ss.product_id IN (
          SELECT DISTINCT product_id FROM stock_snapshots
          WHERE distributor_id = ${distId}
            AND snapshot_date >= ${cutoffStr}::date
            AND (soh > 0 OR soo > 0)
        )`
      : sql``;

    // Distinct product IDs that have snapshots in window (for total count)
    const countRows = await db.execute<{ total: string }>(sql`
      SELECT COUNT(DISTINCT ss.product_id) AS total
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      WHERE ss.distributor_id = ${distId}
        AND ss.snapshot_date >= ${cutoffStr}::date
        ${activeFilter}
        ${brand  ? sql`AND p.brand = ${brand}` : sql``}
        ${search ? sql`AND (p.vpn_normalized ILIKE ${"%" + search + "%"} OR p.description ILIKE ${"%" + search + "%"})` : sql``}
    `);
    const total = parseInt(String(countRows.rows[0]?.total ?? "0"), 10);

    // Paginated product list (ordered by VPN)
    const productIdRows = await db.execute<{ product_id: string }>(sql`
      SELECT DISTINCT ss.product_id
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      WHERE ss.distributor_id = ${distId}
        AND ss.snapshot_date >= ${cutoffStr}::date
        ${activeFilter}
        ${brand  ? sql`AND p.brand = ${brand}` : sql``}
        ${search ? sql`AND (p.vpn_normalized ILIKE ${"%" + search + "%"} OR p.description ILIKE ${"%" + search + "%"})` : sql``}
      ORDER BY ss.product_id
      LIMIT ${limit} OFFSET ${offset}
    `);
    const productIds = productIdRows.rows.map((r) => parseInt(String(r.product_id), 10));

    if (productIds.length === 0) {
      res.json({
        distributorId:  distId,
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

    // Fetch all snapshots in window for the paginated products
    type SnapshotRow = {
      product_id:    string;
      vpn_normalized: string;
      vpn_display:   string;
      brand:         string;
      description:   string;
      snapshot_date: string;
      soh:           string | null;
      soo:           string | null;
      sell_price:    string | null;
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

    // Group by product and compute movement
    const byProduct = new Map<number, SnapshotRow[]>();
    for (const row of snapshotRows.rows) {
      const pid = parseInt(String(row.product_id), 10);
      const group = byProduct.get(pid);
      if (group) group.push(row);
      else byProduct.set(pid, [row]);
    }

    const products = [...byProduct.entries()].map(([, snaps]) => {
      const sorted  = snaps; // already ASC from DB
      const latest  = sorted[sorted.length - 1]!;
      const previous = sorted.length > 1 ? sorted[sorted.length - 2]! : null;

      const latestSoh  = latest.soh  != null ? parseInt(String(latest.soh),  10) : null;
      const latestSoo  = latest.soo  != null ? parseInt(String(latest.soo),  10) : null;
      const prevSoh    = previous?.soh != null ? parseInt(String(previous.soh), 10) : null;
      const latestSell = latest.sell_price     != null ? parseFloat(latest.sell_price) : null;

      const movement       = latestSoh != null && prevSoh != null ? latestSoh - prevSoh : null;
      const movementSince  = previous?.snapshot_date ?? null;
      const isNew          = sorted.length === 1;

      // Price spread flag: from the latest snapshot's persisted sell_price_max
      const priceSpreadFlag =
        latest.sell_price_max != null && latest.sell_price != null
          ? {
              minPrice: parseFloat(latest.sell_price),
              maxPrice: parseFloat(latest.sell_price_max),
            }
          : null;

      return {
        productId:        parseInt(String(latest.product_id), 10),
        vpnNormalized:    latest.vpn_normalized,
        vpnDisplay:       latest.vpn_display,
        brand:            latest.brand,
        description:      latest.description,
        snapshots:        sorted.map((s) => ({
          snapshotDate: s.snapshot_date,
          soh:          s.soh  != null ? parseInt(String(s.soh),  10) : null,
          soo:          s.soo  != null ? parseInt(String(s.soo),  10) : null,
          sellPrice:    s.sell_price != null ? parseFloat(s.sell_price) : null,
        })),
        latestSoh,
        latestSoo,
        latestSellPrice: latestSell,
        movement,
        movementSinceDate: movementSince,
        isNew,
        priceSpreadFlag,
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
