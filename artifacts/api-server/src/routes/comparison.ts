import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/comparison", requireAuth, async (req, res): Promise<void> => {
  const brand     = (req.query.brand    as string | undefined)?.trim().toUpperCase() || null;
  const search    = (req.query.search   as string | undefined)?.trim() || null;
  const page      = Math.max(1, parseInt((req.query.page     as string) ?? "1") || 1);
  const pageSize  = Math.max(0, parseInt((req.query.pageSize as string) ?? "0") || 0);
  // showStale=true includes products where no distributor has a current snapshot.
  // Default false: only products with at least one current distributor snapshot are returned.
  const showStale = (req.query.showStale as string | undefined) === "true";

  const searchPattern = search ? `%${search}%` : null;
  const limitVal  = pageSize > 0 ? pageSize : null;   // null → LIMIT NULL → no cap
  const offsetVal = pageSize > 0 ? (page - 1) * pageSize : 0;

  // ── Single CTE query ────────────────────────────────────────────────────────
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
      snapshotDate:    string | null;
      isCurrent:       boolean;
    }>;
  };

  const { rows } = await pool.query<QueryRow>(`
    WITH
      distributor_current_dates AS (
        SELECT distributor_id, MAX(snapshot_date) AS current_date
        FROM uploads
        WHERE status = 'committed'
        GROUP BY distributor_id
      ),
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
          AND ($5::boolean = true OR p.id IN (
            SELECT DISTINCT ss2.product_id
            FROM stock_snapshots ss2
            JOIN distributor_current_dates dcd2
              ON dcd2.distributor_id = ss2.distributor_id
             AND ss2.snapshot_date  >= dcd2.current_date
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
          'soo',             l.soo,
          'snapshotDate',    l.snapshot_date,
          'isCurrent',       (
            l.snapshot_date IS NOT NULL
            AND dcd.current_date IS NOT NULL
            AND l.snapshot_date >= dcd.current_date
          )
        ) ORDER BY d.is_baseline DESC, d.name
      ) AS distributor_data
    FROM paged_products pp
    CROSS JOIN distributors d
    LEFT JOIN latest_ss l ON l.product_id = pp.id AND l.distributor_id = d.id
    LEFT JOIN distributor_current_dates dcd ON dcd.distributor_id = d.id
    CROSS JOIN total t
    GROUP BY pp.id, pp.vpn_normalized, pp.vpn_display, pp.brand, pp.description, t.cnt
    ORDER BY pp.brand, pp.vpn_normalized
  `, [brand, searchPattern, limitVal, offsetVal, showStale]);

  // ── Distributor metadata with latest committed upload date ──────────────────
  type DistRow = {
    id: number;
    name: string;
    is_baseline: boolean;
    staleness_threshold_days: number;
    created_at: Date;
    latest_upload_date: string | null;
  };
  const { rows: distRows } = await pool.query<DistRow>(`
    SELECT d.id, d.name, d.is_baseline, d.staleness_threshold_days, d.created_at,
      (SELECT MAX(u.snapshot_date)::text
       FROM uploads u
       WHERE u.distributor_id = d.id AND u.status = 'committed'
      ) AS latest_upload_date
    FROM distributors d
    ORDER BY d.is_baseline DESC, d.name
  `);

  const totalCount = rows.length > 0 ? rows[0].total_count : 0;

  // ── Assemble response rows (cheap arithmetic only) ──────────────────────────
  const comparisonRows = rows.map((row) => {
    const distData = row.distributor_data ?? [];

    // Find baseline (Dicker) sell price — only from a current snapshot
    let dickerPrice: number | null = null;
    for (const d of distData) {
      if (d.isBaseline && d.sellPrice != null && d.isCurrent) {
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
      // Only compute deltas when both sides are current
      if (!d.isBaseline && d.isCurrent && sellPrice != null && dickerPrice != null) {
        priceDelta    = sellPrice - dickerPrice;
        priceDeltaPct = dickerPrice !== 0
          ? ((sellPrice - dickerPrice) / dickerPrice) * 100
          : null;
      }

      // Only current competitors count toward cheapest
      if (!d.isBaseline && d.isCurrent && sellPrice != null) {
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
        snapshotDate:     d.snapshotDate ?? null,
        isCurrent:        d.isCurrent ?? false,
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
      latestUploadDate:       d.latest_upload_date ?? null,
    })),
    total:    totalCount,
    page,
    pageSize: pageSize || null,
  });
});

export default router;
