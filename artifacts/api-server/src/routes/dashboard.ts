import { Router } from "express";
import { db, distributorsTable, uploadsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
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

  res.json({
    distributorCards,
    totalProducts: 0,
    dickerMostExpensiveCount: 0,
    totalNetMovement: 0,
  });
});

export default router;
