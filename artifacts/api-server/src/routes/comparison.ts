import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/comparison", requireAuth, async (req, res): Promise<void> => {
  const brand     = (req.query.brand    as string | undefined)?.trim().toUpperCase() || null;
  const search       = (req.query.search       as string | undefined)?.trim() || null;
  const page         = Math.max(1, parseInt((req.query.page     as string) ?? "1") || 1);
  const pageSize     = Math.max(0, parseInt((req.query.pageSize as string) ?? "0") || 0);
  // showStale=true includes products where no distributor has a current snapshot.
  // Default false: only products with at least one current distributor snapshot are returned.
  const showStale    = (req.query.showStale    as string | undefined) === "true";
  // partialMatch=true uses %search% across VPN + description; default is exact VPN-only match.
  const partialMatch = (req.query.partialMatch as string | undefined) === "true";

  const searchPattern = search ? (partialMatch ? `%${search}%` : search) : null;
  const limitVal  = pageSize > 0 ? pageSize : null;   // null → LIMIT NULL → no cap
  const offsetVal = pageSize > 0 ? (page - 1) * pageSize : 0;

  // ── Single CTE query ────────────────────────────────────────────────────────
  type QueryRow = {
    product_id:          number;
    vpn_normalized:      string;
    vpn_display:         string;
    brand:               string;
    description:         string;
    total_count:         number;
    ingram_weekly_est:   string | null;
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
          AND EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.upload_id = uploads.id)
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
            OR ($6::boolean = true AND p.description ILIKE $2)
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
      ),
      -- Ingram Micro weekly sell-through estimate (last 30 days, normalised to 7-day rate)
      -- Uses same LAG(soh)/LAG(soo) logic as the movement classifier.
      ingram_dist AS (
        SELECT id FROM distributors WHERE LOWER(name) LIKE '%ingram%' LIMIT 1
      ),
      ingram_ordered AS (
        SELECT
          ss.product_id,
          ss.soh,
          ss.soo,
          ss.snapshot_date,
          LAG(ss.soh) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soh,
          LAG(ss.soo) OVER (PARTITION BY ss.product_id ORDER BY ss.snapshot_date) AS prev_soo
        FROM stock_snapshots ss
        WHERE ss.distributor_id = (SELECT id FROM ingram_dist)
          AND ss.snapshot_date >= CURRENT_DATE - INTERVAL '30 days'
          AND ss.product_id IN (SELECT id FROM paged_products)
      ),
      ingram_weekly AS (
        SELECT
          product_id,
          CASE
            WHEN COUNT(*) >= 2
              AND (MAX(snapshot_date) - MIN(snapshot_date)) >= 7
            THEN
              COALESCE(SUM(
                CASE
                  WHEN soh - prev_soh < 0
                    THEN -(soh - prev_soh)
                  WHEN soh - prev_soh > 0
                    AND (COALESCE(soo, 0) - COALESCE(prev_soo, 0)) < 0
                    THEN GREATEST(0, -(COALESCE(soo, 0) - COALESCE(prev_soo, 0)) - (soh - prev_soh))
                  ELSE 0
                END
              ) FILTER (WHERE prev_soh IS NOT NULL AND soh IS NOT NULL), 0)
              * 7.0
              / GREATEST(1, MAX(snapshot_date) - MIN(snapshot_date))
            ELSE NULL
          END AS weekly_est
        FROM ingram_ordered
        GROUP BY product_id
      )
    SELECT
      pp.id            AS product_id,
      pp.vpn_normalized,
      pp.vpn_display,
      pp.brand,
      pp.description,
      t.cnt            AS total_count,
      MAX(iw.weekly_est) AS ingram_weekly_est,
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
            AND (
              -- Standard: snapshot is from this distributor's most recent upload
              (dcd.current_date IS NOT NULL AND l.snapshot_date >= dcd.current_date)
              -- Fallback: snapshot is within 14 days. Handles distributors that
              -- send partial uploads (e.g. IT-hardware-only files that omit bags/
              -- accessories). The product's last-seen price is still valid even
              -- though a newer partial file arrived since.
              OR l.snapshot_date >= CURRENT_DATE - INTERVAL '14 days'
            )
          )
        ) ORDER BY d.is_baseline DESC, d.name
      ) AS distributor_data
    FROM paged_products pp
    CROSS JOIN distributors d
    LEFT JOIN latest_ss l ON l.product_id = pp.id AND l.distributor_id = d.id
    LEFT JOIN distributor_current_dates dcd ON dcd.distributor_id = d.id
    LEFT JOIN ingram_weekly iw ON iw.product_id = pp.id
    CROSS JOIN total t
    GROUP BY pp.id, pp.vpn_normalized, pp.vpn_display, pp.brand, pp.description, t.cnt
    ORDER BY pp.brand, pp.vpn_normalized
  `, [brand, searchPattern, limitVal, offsetVal, showStale, partialMatch]);

  // ── Distributor metadata with latest committed upload date ──────────────────
  type DistRow = {
    id: number;
    name: string;
    is_baseline: boolean;
    staleness_threshold_days: number;
    created_at: Date;
    latest_upload_date: string | null;
    latest_upload_date_with_rows: string | null;
  };
  const { rows: distRows } = await pool.query<DistRow>(`
    SELECT d.id, d.name, d.is_baseline, d.staleness_threshold_days, d.created_at,
      (SELECT MAX(u.snapshot_date)::text
       FROM uploads u
       WHERE u.distributor_id = d.id AND u.status = 'committed'
      ) AS latest_upload_date,
      (SELECT MAX(u.snapshot_date)::text
       FROM uploads u
       WHERE u.distributor_id = d.id AND u.status = 'committed'
         AND EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.upload_id = u.id)
      ) AS latest_upload_date_with_rows
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

    const ingramWeeklySales = row.ingram_weekly_est != null
      ? parseFloat(String(row.ingram_weekly_est))
      : null;

    return {
      productId:            row.product_id,
      vpnNormalized:        row.vpn_normalized,
      vpnDisplay:           row.vpn_display,
      brand:                row.brand,
      description:          row.description,
      distributors,
      cheapestCompetitorId,
      dickerIsMostExpensive,
      ingramWeeklySales,
    };
  });

  // Build freshness warnings: distributors whose newest committed upload has no rows,
  // so the anchor fell back to an older date.
  const freshnessWarnings = distRows
    .filter((d) =>
      d.latest_upload_date != null &&
      d.latest_upload_date !== d.latest_upload_date_with_rows,
    )
    .map((d) => ({
      distributorId:    d.id,
      distributorName:  d.name,
      latestUploadDate: d.latest_upload_date!,
      fallbackDate:     d.latest_upload_date_with_rows ?? null,
    }));

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
    freshnessWarnings,
  });
});

export default router;
