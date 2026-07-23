import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/comparison", requireAuth, async (req, res): Promise<void> => {
  const brand    = (req.query.brand  as string | undefined)?.trim().toUpperCase() || null;
  const search   = (req.query.search as string | undefined)?.trim() || null;
  const page     = Math.max(1, parseInt((req.query.page     as string) ?? "1") || 1);
  const pageSize = Math.max(0, parseInt((req.query.pageSize as string) ?? "0") || 0);

  const searchPattern = search ? `%${search}%` : null;
  const limitVal  = pageSize > 0 ? pageSize : null;   // null → LIMIT NULL → no cap
  const offsetVal = pageSize > 0 ? (page - 1) * pageSize : 0;

  // ── Single CTE query ────────────────────────────────────────────────────
  type QueryRow = {
    product_id:     number;
    vpn_normalized: string;
    vpn_display:    string;
    brand:          string;
    description:    string;
    total_count:    number;
    distributor_data: Array<{
      distributorId:   number;
      distributorName: string;
      isBaseline:      boolean;
      sellPrice:       string | null;
      soh:             number | null;
      soo:             number | null;
    }>;
  };

  const { rows } = await pool.query<QueryRow>(`
    WITH
      filtered_products AS (
        SELECT p.id, p.vpn_normalized, p.vpn_display, p.brand, p.description
        FROM products p
        JOIN brands b ON b.canonical_name = p.brand AND b.reference_only = false
        WHERE ($1::text IS NULL OR p.brand = $1)
          AND ($2::text IS NULL OR (
               p.vpn_normalized ILIKE $2
            OR p.vpn_display    ILIKE $2
            OR p.description    ILIKE $2
          ))
      ),
      total AS (
        SELECT COUNT(*)::int AS cnt FROM filtered_products
      ),
      paged_products AS (
        SELECT fp.*
        FROM filtered_products fp
        ORDER BY fp.brand, fp.vpn_normalized
        LIMIT $3 OFFSET $4
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
        WHERE ss.product_id IN (SELECT id FROM paged_products)
        ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC, ss.id DESC
      )
    SELECT
      pp.id            AS product_id,
      pp.vpn_normalized,
      pp.vpn_display,
      pp.brand,
      pp.description,
      t.cnt            AS total_count,
      json_agg(
        json_build_object(
          'distributorId',   d.id,
          'distributorName', d.name,
          'isBaseline',      d.is_baseline,
          'sellPrice',       l.sell_price,
          'soh',             l.soh,
          'soo',             l.soo
        ) ORDER BY d.is_baseline DESC, d.name
      ) AS distributor_data
    FROM paged_products pp
    CROSS JOIN distributors d
    LEFT JOIN latest_ss l ON l.product_id = pp.id AND l.distributor_id = d.id
    CROSS JOIN total t
    GROUP BY pp.id, pp.vpn_normalized, pp.vpn_display, pp.brand, pp.description, t.cnt
    ORDER BY pp.brand, pp.vpn_normalized
  `, [brand, searchPattern, limitVal, offsetVal]);

  // ── Distributor metadata (tiny table, fine as second query) ─────────────
  type DistRow = { id: number; name: string; is_baseline: boolean; staleness_threshold_days: number; created_at: Date };
  const { rows: distRows } = await pool.query<DistRow>(
    `SELECT id, name, is_baseline, staleness_threshold_days, created_at
     FROM distributors ORDER BY is_baseline DESC, name`,
  );

  const totalCount = rows.length > 0 ? rows[0].total_count : 0;

  // ── Assemble response rows (cheap arithmetic only) ───────────────────────
  const comparisonRows = rows.map((row) => {
    const distData = row.distributor_data ?? [];

    // Find baseline (Dicker) sell price — comes first because ORDER BY is_baseline DESC
    let dickerPrice: number | null = null;
    for (const d of distData) {
      if (d.isBaseline && d.sellPrice != null) {
        dickerPrice = Number(d.sellPrice);
        break;
      }
    }

    let cheapestCompetitorId:    number | null = null;
    let cheapestCompetitorPrice: number | null = null;

    const distributors = distData.map((d) => {
      const sellPrice = d.sellPrice != null ? Number(d.sellPrice) : null;

      let priceDelta:    number | null = null;
      let priceDeltaPct: number | null = null;
      if (!d.isBaseline && sellPrice != null && dickerPrice != null) {
        priceDelta    = sellPrice - dickerPrice;
        priceDeltaPct = dickerPrice !== 0
          ? ((sellPrice - dickerPrice) / dickerPrice) * 100
          : null;
      }

      if (!d.isBaseline && sellPrice != null) {
        if (cheapestCompetitorPrice == null || sellPrice < cheapestCompetitorPrice) {
          cheapestCompetitorPrice = sellPrice;
          cheapestCompetitorId   = d.distributorId;
        }
      }

      return {
        distributorId:    d.distributorId,
        distributorName:  d.distributorName,
        isBaseline:       d.isBaseline,
        sellPrice,
        soh:              d.soh,
        soo:              d.soo,
        movement:         null,
        movementSinceDate: null,
        isNew:            true,
        priceDelta,
        priceDeltaPct,
      };
    });

    const dickerIsMostExpensive =
      dickerPrice != null &&
      cheapestCompetitorPrice != null &&
      dickerPrice > cheapestCompetitorPrice;

    return {
      productId:            row.product_id,
      vpnNormalized:        row.vpn_normalized,
      vpnDisplay:           row.vpn_display,
      brand:                row.brand,
      description:          row.description,
      distributors,
      cheapestCompetitorId,
      dickerIsMostExpensive,
    };
  });

  res.json({
    rows: comparisonRows,
    distributors: distRows.map((d) => ({
      id:                     d.id,
      name:                   d.name,
      isBaseline:             d.is_baseline,
      stalenessThresholdDays: d.staleness_threshold_days,
      createdAt:              d.created_at.toISOString(),
      lastUploadAt:           null,
      lastUploadStatus:       null,
    })),
    total:    totalCount,
    page,
    pageSize: pageSize || null,
  });
});

export default router;
