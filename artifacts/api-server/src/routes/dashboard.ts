import { Router } from "express";
import { db, distributorsTable, uploadsTable, productsTable, stockSnapshotsTable } from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const today = new Date();

  const distributors = await db.select().from(distributorsTable).orderBy(distributorsTable.name);

  const distributorCards = await Promise.all(
    distributors.map(async (d) => {
      const [lastUpload] = await db
        .select()
        .from(uploadsTable)
        .where(and(eq(uploadsTable.distributorId, d.id), eq(uploadsTable.status, "committed")))
        .orderBy(desc(uploadsTable.snapshotDate))
        .limit(1);

      let freshness: "fresh" | "stale_warn" | "stale_critical" | "no_data" = "no_data";

      if (lastUpload) {
        const snapshotDate = new Date(lastUpload.snapshotDate);
        const daysDiff = Math.floor((today.getTime() - snapshotDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysDiff === 0) {
          freshness = "fresh";
        } else if (daysDiff <= 2) {
          freshness = "stale_warn";
        } else if (daysDiff > d.stalenessThresholdDays) {
          freshness = "stale_critical";
        } else {
          freshness = "stale_warn";
        }
      }

      return {
        distributorId: d.id,
        name: d.name,
        isBaseline: d.isBaseline,
        stalenessThresholdDays: d.stalenessThresholdDays,
        lastUploadAt: lastUpload?.uploadedAt?.toISOString() ?? null,
        lastUploadDate: lastUpload?.snapshotDate ?? null,
        freshness,
      };
    }),
  );

  // Total products tracked
  const [productCountRow] = await db.select({ count: sql<number>`count(*)` }).from(productsTable);
  const totalProducts = Number(productCountRow?.count ?? 0);

  // Find baseline distributor
  const baseline = distributors.find((d) => d.isBaseline);

  let dickerMostExpensiveCount = 0;
  let totalNetMovement = 0;

  if (baseline) {
    // Count where baseline is most expensive (simplified: count products where baseline price > any competitor price)
    const result = await db.execute(sql`
      SELECT COUNT(DISTINCT p.id) as count
      FROM products p
      JOIN stock_snapshots base_ss ON base_ss.product_id = p.id AND base_ss.distributor_id = ${baseline.id}
      JOIN (
        SELECT product_id, MAX(upload_id) as max_upload_id
        FROM stock_snapshots
        WHERE distributor_id = ${baseline.id}
        GROUP BY product_id
      ) latest_base ON latest_base.product_id = base_ss.product_id AND latest_base.max_upload_id = base_ss.upload_id
      WHERE EXISTS (
        SELECT 1 FROM stock_snapshots comp_ss
        JOIN (
          SELECT product_id, distributor_id, MAX(upload_id) as max_upload_id
          FROM stock_snapshots
          WHERE distributor_id != ${baseline.id}
          GROUP BY product_id, distributor_id
        ) latest_comp ON latest_comp.product_id = comp_ss.product_id 
          AND latest_comp.distributor_id = comp_ss.distributor_id 
          AND latest_comp.max_upload_id = comp_ss.upload_id
        WHERE comp_ss.product_id = p.id
          AND comp_ss.sell_price < base_ss.sell_price
      )
    `);
    dickerMostExpensiveCount = Number((result.rows[0] as { count: string })?.count ?? 0);
  }

  res.json({
    distributorCards,
    totalProducts,
    dickerMostExpensiveCount,
    totalNetMovement,
  });
});

export default router;
