import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/insights", requireAuth, async (req, res): Promise<void> => {
  const brandId = parseInt((req.query.brandId as string) ?? "0");
  if (!brandId || isNaN(brandId)) {
    res.status(400).json({ error: "brandId is required" });
    return;
  }

  // Brand lookup
  const brandResult = await pool.query<{ canonical_name: string }>(
    `SELECT canonical_name FROM brands WHERE id = $1`,
    [brandId],
  );
  const brandRow = brandResult.rows[0];
  if (!brandRow) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }
  const brandName = brandRow.canonical_name;

  // Distributors
  const distResult = await pool.query<{ id: number; name: string; is_baseline: boolean }>(
    `SELECT id, name, is_baseline FROM distributors ORDER BY is_baseline DESC, name`,
  );
  const allDistributors = distResult.rows;
  const baseline = allDistributors.find((d) => d.is_baseline);
  const competitors = allDistributors.filter((d) => !d.is_baseline);

  if (!baseline) {
    res.status(400).json({ error: "No baseline distributor configured" });
    return;
  }

  // ── Shared CTEs ──────────────────────────────────────────────────────────
  // brand_products: all products for this brand
  // latest_ss: most-recent snapshot per product+distributor (for this brand)
  // dicker: baseline rows
  // comps: competitor rows
  const SHARED_CTES = `
    brand_products AS (
      SELECT id, vpn_normalized, vpn_display, description
      FROM products
      WHERE brand = $1
    ),
    latest_ss AS (
      SELECT DISTINCT ON (ss.product_id, ss.distributor_id)
        ss.product_id,
        ss.distributor_id,
        ss.sell_price::numeric AS sell_price,
        ss.soh,
        ss.soo,
        ss.snapshot_date
      FROM stock_snapshots ss
      WHERE ss.product_id IN (SELECT id FROM brand_products)
      ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC
    ),
    dicker AS (
      SELECT ls.product_id, ls.sell_price, ls.soh, ls.soo, ls.snapshot_date
      FROM latest_ss ls
      JOIN distributors d ON d.id = ls.distributor_id AND d.is_baseline = true
    ),
    comps AS (
      SELECT ls.product_id, ls.distributor_id, d.name AS disti_name, ls.sell_price, ls.soh, ls.soo
      FROM latest_ss ls
      JOIN distributors d ON d.id = ls.distributor_id AND d.is_baseline = false
    )
  `;

  // ── 1. PRICE COMPETITIVENESS ─────────────────────────────────────────────
  const priceResult = await pool.query(`
    WITH ${SHARED_CTES},
    benchmarked AS (
      SELECT
        dd.product_id,
        dd.sell_price                                                         AS dicker_price,
        COALESCE(dd.soh, 0)                                                   AS dicker_soh,
        MIN(c.sell_price)                                                     AS min_comp_price,
        MIN(CASE WHEN COALESCE(c.soh,0) > 0 THEN c.sell_price END)           AS min_instock_comp_price,
        MAX(CASE WHEN COALESCE(c.soh,0) > 0 THEN c.disti_name END)           AS cheapest_instock_disti
      FROM dicker dd
      JOIN comps c ON c.product_id = dd.product_id
      WHERE dd.sell_price IS NOT NULL AND c.sell_price IS NOT NULL
      GROUP BY dd.product_id, dd.sell_price, dd.soh
    ),
    dearer_rows AS (
      SELECT *,
        dicker_price - min_comp_price                                          AS gap_dollars,
        CASE WHEN min_comp_price > 0
          THEN ROUND(((dicker_price - min_comp_price) / min_comp_price * 100)::numeric, 2)
        END                                                                    AS gap_pct
      FROM benchmarked
      WHERE dicker_price > min_comp_price
    ),
    summary AS (
      SELECT
        COUNT(*)::int                                                              AS total_benchmarked,
        COUNT(*) FILTER (WHERE dicker_price <= min_comp_price)::int              AS win_count,
        COUNT(*) FILTER (WHERE dicker_price > min_comp_price)::int               AS dearer_count,
        ROUND(AVG(CASE WHEN dicker_price > min_comp_price THEN dicker_price - min_comp_price END)::numeric, 2)
                                                                                  AS avg_gap_dollars,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY CASE WHEN dicker_price > min_comp_price THEN dicker_price - min_comp_price END
        )::numeric, 2)                                                            AS median_gap_dollars,
        ROUND(AVG(CASE WHEN dicker_price > min_comp_price AND min_comp_price > 0
          THEN (dicker_price - min_comp_price) / min_comp_price * 100 END)::numeric, 2)
                                                                                  AS avg_gap_pct,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY CASE WHEN dicker_price > min_comp_price AND min_comp_price > 0
            THEN (dicker_price - min_comp_price) / min_comp_price * 100 END
        )::numeric, 2)                                                            AS median_gap_pct,
        ROUND(COALESCE(SUM(
          CASE WHEN dicker_price > min_instock_comp_price AND min_instock_comp_price IS NOT NULL
            THEN (dicker_price - min_instock_comp_price) * GREATEST(dicker_soh, 0)
          END
        ), 0)::numeric, 2)                                                        AS aggregate_exposure
      FROM benchmarked
    ),
    reprice_targets AS (
      SELECT
        p.vpn_display, p.description,
        b.dicker_price, b.min_instock_comp_price AS cheapest_comp_price,
        b.cheapest_instock_disti AS cheapest_comp_name,
        ROUND((b.dicker_price - b.min_instock_comp_price)::numeric, 2)  AS gap_dollars,
        CASE WHEN b.min_instock_comp_price > 0
          THEN ROUND(((b.dicker_price - b.min_instock_comp_price) / b.min_instock_comp_price * 100)::numeric, 2)
        END                                                              AS gap_pct,
        b.dicker_soh
      FROM benchmarked b
      JOIN brand_products p ON p.id = b.product_id
      WHERE b.dicker_price > b.min_instock_comp_price AND b.min_instock_comp_price IS NOT NULL
      ORDER BY (b.dicker_price - b.min_instock_comp_price) DESC
      LIMIT 20
    ),
    headroom AS (
      SELECT
        p.vpn_display, p.description,
        b.dicker_price, b.min_comp_price AS next_cheapest_price,
        ROUND((b.min_comp_price - b.dicker_price)::numeric, 2)            AS headroom_dollars,
        CASE WHEN b.dicker_price > 0
          THEN ROUND(((b.min_comp_price - b.dicker_price) / b.dicker_price * 100)::numeric, 2)
        END                                                                AS headroom_pct,
        b.dicker_soh
      FROM benchmarked b
      JOIN brand_products p ON p.id = b.product_id
      WHERE b.dicker_price < b.min_comp_price
      ORDER BY (b.min_comp_price - b.dicker_price) DESC
      LIMIT 20
    ),
    comp_undercut AS (
      SELECT
        c.distributor_id,
        c.disti_name,
        COUNT(*) FILTER (
          WHERE c.sell_price IS NOT NULL AND dd.sell_price IS NOT NULL AND c.sell_price < dd.sell_price
        )::int AS undercut_count,
        COUNT(*) FILTER (
          WHERE c.sell_price IS NOT NULL AND dd.sell_price IS NOT NULL
        )::int  AS shared_count
      FROM comps c
      JOIN dicker dd ON dd.product_id = c.product_id
      GROUP BY c.distributor_id, c.disti_name
    )
    SELECT
      (SELECT row_to_json(s) FROM summary s)                              AS summary,
      (SELECT json_agg(r) FROM reprice_targets r)                        AS reprice_targets,
      (SELECT json_agg(h) FROM headroom h)                               AS headroom,
      (SELECT json_agg(u) FROM comp_undercut u)                          AS comp_undercut
  `, [brandName]);

  const priceRow = priceResult.rows[0];

  // ── 2. STOCK POSITION ────────────────────────────────────────────────────
  const stockResult = await pool.query(`
    WITH ${SHARED_CTES},
    lost_sales AS (
      SELECT
        p.vpn_display, p.description,
        COALESCE(dd.soh, 0) AS dicker_soh,
        json_agg(json_build_object('name', c.disti_name, 'soh', c.soh)
          ORDER BY c.soh DESC NULLS LAST) AS competitors_in_stock,
        SUM(COALESCE(c.soh, 0)) AS total_comp_soh
      FROM dicker dd
      JOIN brand_products p ON p.id = dd.product_id
      JOIN comps c ON c.product_id = dd.product_id AND COALESCE(c.soh, 0) > 0
      WHERE COALESCE(dd.soh, 0) = 0
      GROUP BY p.vpn_display, p.description, dd.soh
      ORDER BY SUM(COALESCE(c.soh, 0)) DESC
      LIMIT 50
    ),
    avail_wins AS (
      SELECT
        p.vpn_display, p.description,
        COALESCE(dd.soh, 0) AS dicker_soh,
        COUNT(c.product_id)::int AS out_of_stock_comp_count
      FROM dicker dd
      JOIN brand_products p ON p.id = dd.product_id
      JOIN comps c ON c.product_id = dd.product_id
      WHERE COALESCE(dd.soh, 0) > 0
      GROUP BY p.vpn_display, p.description, dd.soh
      HAVING MAX(COALESCE(c.soh, 0)) = 0
      ORDER BY dd.soh DESC
      LIMIT 50
    ),
    soh_totals AS (
      SELECT
        SUM(CASE WHEN d.is_baseline THEN COALESCE(ls.soh, 0) END)::int AS dicker_total_soh,
        json_agg(
          CASE WHEN NOT d.is_baseline
            THEN json_build_object('id', d.id, 'name', d.name, 'total', COALESCE(comp_soh.total, 0))
          END
        ) FILTER (WHERE NOT d.is_baseline) AS comp_soh_totals
      FROM distributors d
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(ls.soh, 0))::int AS total
        FROM latest_ss ls
        WHERE ls.distributor_id = d.id
      ) comp_soh ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ls.soh), 0) AS soh
        FROM latest_ss ls
        WHERE ls.distributor_id = d.id AND d.is_baseline
      ) ls ON true
    ),
    low_stock AS (
      SELECT
        p.vpn_display, p.description,
        COALESCE(dd.soh, 0) AS dicker_soh,
        (array_agg(c.disti_name ORDER BY COALESCE(c.soh, 0) DESC))[1] AS deepest_comp_name,
        MAX(COALESCE(c.soh, 0))::int AS deepest_comp_soh
      FROM dicker dd
      JOIN brand_products p ON p.id = dd.product_id
      JOIN comps c ON c.product_id = dd.product_id
      WHERE COALESCE(dd.soh, 0) BETWEEN 1 AND 5
        AND COALESCE(c.soh, 0) >= 20
      GROUP BY p.vpn_display, p.description, dd.soh
      ORDER BY dicker_soh ASC
      LIMIT 30
    )
    SELECT
      (SELECT json_agg(r) FROM lost_sales r)                AS lost_sales,
      (SELECT COUNT(*)::int FROM lost_sales)                AS lost_sales_count,
      (SELECT json_agg(r) FROM avail_wins r)                AS avail_wins,
      (SELECT COUNT(*)::int FROM avail_wins)                AS avail_wins_count,
      (SELECT row_to_json(s) FROM soh_totals s)             AS soh_totals,
      (SELECT json_agg(r) FROM low_stock r)                 AS low_stock
  `, [brandName]);

  const stockRow = stockResult.rows[0];

  // ── 3. RANGE & COVERAGE ──────────────────────────────────────────────────
  const rangeResult = await pool.query(`
    WITH ${SHARED_CTES},
    dicker_vpns AS (
      SELECT DISTINCT product_id FROM dicker
    ),
    comp_vpns AS (
      SELECT DISTINCT product_id FROM comps
    ),
    exclusive_lines AS (
      SELECT
        p.vpn_display, p.description,
        COALESCE(dd.sell_price, 0) AS dicker_price,
        COALESCE(dd.soh, 0)        AS dicker_soh
      FROM dicker_vpns dv
      JOIN brand_products p ON p.id = dv.product_id
      JOIN dicker dd ON dd.product_id = dv.product_id
      WHERE dv.product_id NOT IN (SELECT product_id FROM comp_vpns)
      ORDER BY COALESCE(dd.soh, 0) DESC, COALESCE(dd.sell_price, 0) DESC
      LIMIT 50
    ),
    range_gaps AS (
      SELECT
        p.vpn_display, p.description,
        c.disti_name AS competitor_name,
        COALESCE(c.sell_price, 0) AS price,
        COALESCE(c.soh, 0)        AS soh
      FROM comp_vpns cv
      JOIN brand_products p ON p.id = cv.product_id
      JOIN comps c ON c.product_id = cv.product_id
      WHERE cv.product_id NOT IN (SELECT product_id FROM dicker_vpns)
        AND COALESCE(c.soh, 0) > 0
      ORDER BY c.soh DESC NULLS LAST
      LIMIT 50
    ),
    coverage AS (
      SELECT
        COUNT(DISTINCT dv.product_id)::int AS total_dicker_skus,
        COUNT(DISTINCT cv.product_id)::int AS benchmarked_skus
      FROM dicker_vpns dv
      LEFT JOIN comp_vpns cv ON cv.product_id = dv.product_id
    ),
    per_comp AS (
      SELECT
        d.id AS distributor_id,
        d.name,
        COUNT(DISTINCT c.product_id)::int                               AS sku_count,
        COUNT(DISTINCT c.product_id) FILTER (
          WHERE c.product_id IN (SELECT product_id FROM dicker_vpns)
        )::int                                                          AS shared_with_dicker
      FROM distributors d
      LEFT JOIN comps c ON c.distributor_id = d.id
      WHERE NOT d.is_baseline
      GROUP BY d.id, d.name
      ORDER BY sku_count DESC
    )
    SELECT
      (SELECT json_agg(r) FROM exclusive_lines r)     AS exclusive_lines,
      (SELECT COUNT(*)::int FROM exclusive_lines)      AS exclusive_count,
      (SELECT json_agg(r) FROM range_gaps r)           AS range_gaps,
      (SELECT COUNT(*)::int FROM range_gaps)           AS range_gap_count,
      (SELECT row_to_json(c) FROM coverage c)          AS coverage,
      (SELECT json_agg(c) FROM per_comp c)             AS per_comp
  `, [brandName]);

  const rangeRow = rangeResult.rows[0];

  // ── 4. Snapshot dates ────────────────────────────────────────────────────
  const datesResult = await pool.query<{ distributor_id: number; name: string; latest_date: string; is_baseline: boolean }>(
    `SELECT d.id AS distributor_id, d.name, d.is_baseline,
       MAX(ss.snapshot_date) AS latest_date
     FROM stock_snapshots ss
     JOIN distributors d ON d.id = ss.distributor_id
     JOIN products p ON p.id = ss.product_id AND p.brand = $1
     GROUP BY d.id, d.name, d.is_baseline`,
    [brandName],
  );

  // ── Assemble response ─────────────────────────────────────────────────────
  const summaryData = priceRow.summary as Record<string, unknown> | null ?? {};
  const totalBenchmarked = Number(summaryData.total_benchmarked ?? 0);
  const winCount = Number(summaryData.win_count ?? 0);

  res.json({
    brandName,
    snapshots: {
      dicker: datesResult.rows.find((r) => r.is_baseline) ?? null,
      competitors: datesResult.rows.filter((r) => !r.is_baseline),
    },
    distributors: {
      baseline,
      competitors,
    },
    priceCompetitiveness: {
      totalBenchmarked,
      winCount,
      winRate: totalBenchmarked > 0 ? Math.round((winCount / totalBenchmarked) * 1000) / 10 : null,
      dearer: {
        count: Number(summaryData.dearer_count ?? 0),
        avgGapDollars: Number(summaryData.avg_gap_dollars ?? 0),
        medianGapDollars: Number(summaryData.median_gap_dollars ?? 0),
        avgGapPct: Number(summaryData.avg_gap_pct ?? 0),
        medianGapPct: Number(summaryData.median_gap_pct ?? 0),
      },
      aggregateExposure: Number(summaryData.aggregate_exposure ?? 0),
      repriceTargets: (priceRow.reprice_targets as unknown[]) ?? [],
      headroom: (priceRow.headroom as unknown[]) ?? [],
      competitorUndercut: (priceRow.comp_undercut as unknown[]) ?? [],
    },
    stockPosition: {
      lostSales: {
        count: stockRow.lost_sales_count ?? 0,
        lines: (stockRow.lost_sales as unknown[]) ?? [],
      },
      availabilityWins: {
        count: stockRow.avail_wins_count ?? 0,
        lines: (stockRow.avail_wins as unknown[]) ?? [],
      },
      sohTotals: stockRow.soh_totals ?? {},
      lowStockLines: (stockRow.low_stock as unknown[]) ?? [],
    },
    rangeAndCoverage: {
      exclusiveCount: rangeRow.exclusive_count ?? 0,
      exclusiveLines: (rangeRow.exclusive_lines as unknown[]) ?? [],
      rangeGapCount: rangeRow.range_gap_count ?? 0,
      rangeGaps: (rangeRow.range_gaps as unknown[]) ?? [],
      coverage: rangeRow.coverage ?? {},
      perCompetitor: (rangeRow.per_comp as unknown[]) ?? [],
    },
  });
});

export default router;
