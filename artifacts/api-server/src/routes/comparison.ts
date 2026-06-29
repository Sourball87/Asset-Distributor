import { Router } from "express";
import { db, distributorsTable, productsTable, stockSnapshotsTable, uploadsTable } from "@workspace/db";
import { eq, and, sql, ilike, or } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/comparison", requireAuth, async (req, res): Promise<void> => {
  const { brand, distributorId, search } = req.query as Record<string, string | undefined>;

  const distributors = await db.select().from(distributorsTable).orderBy(distributorsTable.name);
  const baseline = distributors.find((d) => d.isBaseline);

  // Get latest snapshot per product per distributor using a subquery
  const latestSnapshots = await db.execute(sql`
    SELECT DISTINCT ON (ss.product_id, ss.distributor_id)
      ss.id,
      ss.product_id,
      ss.distributor_id,
      ss.upload_id,
      ss.snapshot_date,
      ss.sell_price,
      ss.soh,
      ss.soo
    FROM stock_snapshots ss
    ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC, ss.id DESC
  `);

  // Get previous snapshots for movement calc
  const prevSnapshots = await db.execute(sql`
    SELECT DISTINCT ON (ss.product_id, ss.distributor_id)
      ss.product_id,
      ss.distributor_id,
      ss.snapshot_date as prev_date,
      ss.soh as prev_soh
    FROM stock_snapshots ss
    WHERE NOT EXISTS (
      SELECT 1 FROM stock_snapshots newer
      WHERE newer.product_id = ss.product_id
        AND newer.distributor_id = ss.distributor_id
        AND newer.snapshot_date > ss.snapshot_date
    )
    ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date ASC, ss.id ASC
  `);

  type SnapshotRow = {
    id: number;
    product_id: number;
    distributor_id: number;
    upload_id: number;
    snapshot_date: string;
    sell_price: string | null;
    soh: number | null;
    soo: number | null;
  };

  type PrevRow = {
    product_id: number;
    distributor_id: number;
    prev_date: string;
    prev_soh: number | null;
  };

  const snapshotMap = new Map<string, SnapshotRow>();
  for (const row of latestSnapshots.rows as SnapshotRow[]) {
    snapshotMap.set(`${row.product_id}:${row.distributor_id}`, row);
  }

  // Build map of second-latest for movement
  const allSnapsByProductDisti = new Map<string, SnapshotRow[]>();
  const allSnapshotsRaw = await db.execute(sql`
    SELECT ss.product_id, ss.distributor_id, ss.snapshot_date, ss.soh, ss.upload_id, ss.id, ss.sell_price, ss.soo
    FROM stock_snapshots ss
    ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC
  `);

  for (const row of allSnapshotsRaw.rows as SnapshotRow[]) {
    const key = `${row.product_id}:${row.distributor_id}`;
    if (!allSnapsByProductDisti.has(key)) allSnapsByProductDisti.set(key, []);
    allSnapsByProductDisti.get(key)!.push(row);
  }

  // Products
  let products = await db.select().from(productsTable).orderBy(productsTable.brand, productsTable.vpnNormalized);

  // Filter
  if (brand) products = products.filter((p) => p.brand === brand);
  if (search) {
    const q = search.toLowerCase();
    products = products.filter(
      (p) => p.vpnNormalized.toLowerCase().includes(q) || p.vpnDisplay.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }

  const rows = products.map((product) => {
    let dickerPrice: number | null = null;
    const distributorEntries = distributors.map((d) => {
      const snap = snapshotMap.get(`${product.id}:${d.id}`);
      const allSnaps = allSnapsByProductDisti.get(`${product.id}:${d.id}`) ?? [];
      const isNew = allSnaps.length <= 1;

      let movement: number | null = null;
      let movementSinceDate: string | null = null;

      if (!isNew && allSnaps.length >= 2) {
        const latest = allSnaps[0];
        const previous = allSnaps[1];
        if (latest.soh != null && previous.soh != null) {
          movement = Number(latest.soh) - Number(previous.soh);
          movementSinceDate = previous.snapshot_date;
        }
      }

      const sellPrice = snap?.sell_price != null ? parseFloat(snap.sell_price) : null;
      if (d.isBaseline && sellPrice != null) dickerPrice = sellPrice;

      return {
        distributorId: d.id,
        distributorName: d.name,
        isBaseline: d.isBaseline,
        sellPrice,
        soh: snap?.soh ?? null,
        soo: snap?.soo ?? null,
        movement,
        movementSinceDate,
        isNew,
        priceDelta: null as number | null,
        priceDeltaPct: null as number | null,
      };
    });

    // Compute price deltas vs baseline
    let cheapestCompetitorId: number | null = null;
    let cheapestCompetitorPrice: number | null = null;

    for (const entry of distributorEntries) {
      if (!entry.isBaseline && entry.sellPrice != null && dickerPrice != null) {
        entry.priceDelta = entry.sellPrice - dickerPrice;
        entry.priceDeltaPct = dickerPrice !== 0 ? ((entry.sellPrice - dickerPrice) / dickerPrice) * 100 : null;
      }
      if (!entry.isBaseline && entry.sellPrice != null) {
        if (cheapestCompetitorPrice == null || entry.sellPrice < cheapestCompetitorPrice) {
          cheapestCompetitorPrice = entry.sellPrice;
          cheapestCompetitorId = entry.distributorId;
        }
      }
    }

    const dickerIsMostExpensive =
      dickerPrice != null &&
      cheapestCompetitorPrice != null &&
      dickerPrice > cheapestCompetitorPrice;

    return {
      productId: product.id,
      vpnNormalized: product.vpnNormalized,
      vpnDisplay: product.vpnDisplay,
      brand: product.brand,
      description: product.description,
      distributors: distributorEntries,
      cheapestCompetitorId,
      dickerIsMostExpensive,
    };
  });

  res.json({ rows, distributors: distributors.map((d) => ({ id: d.id, name: d.name, isBaseline: d.isBaseline, stalenessThresholdDays: d.stalenessThresholdDays, createdAt: d.createdAt.toISOString(), lastUploadAt: null, lastUploadStatus: null })) });
});

export default router;
