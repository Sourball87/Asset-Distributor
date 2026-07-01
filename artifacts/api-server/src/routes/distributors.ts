import { Router } from "express";
import { db, distributorsTable, uploadsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  CreateDistributorBody,
  UpdateDistributorBody,
  UpdateDistributorParams,
  DeleteDistributorParams,
} from "@workspace/api-zod";
import { requireAuth, requireElevatedRole } from "../middlewares/auth";

const router = Router();

router.get("/distributors", requireAuth, async (req, res): Promise<void> => {
  const distributors = await db.select().from(distributorsTable).orderBy(distributorsTable.name);

  // Attach last upload info
  const withUploads = await Promise.all(
    distributors.map(async (d) => {
      const [lastUpload] = await db
        .select()
        .from(uploadsTable)
        .where(eq(uploadsTable.distributorId, d.id))
        .orderBy(desc(uploadsTable.uploadedAt))
        .limit(1);

      return {
        id: d.id,
        name: d.name,
        isBaseline: d.isBaseline,
        stalenessThresholdDays: d.stalenessThresholdDays,
        createdAt: d.createdAt.toISOString(),
        lastUploadAt: lastUpload?.uploadedAt?.toISOString() ?? null,
        lastUploadStatus: lastUpload?.status ?? null,
      };
    }),
  );

  res.json(withUploads);
});

router.post("/distributors", requireElevatedRole, async (req, res): Promise<void> => {
  const parsed = CreateDistributorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, isBaseline = false, stalenessThresholdDays = 1 } = parsed.data;

  // If marking as baseline, unset existing baseline first
  if (isBaseline) {
    await db.update(distributorsTable).set({ isBaseline: false }).where(eq(distributorsTable.isBaseline, true));
  }

  const [created] = await db
    .insert(distributorsTable)
    .values({ name, isBaseline, stalenessThresholdDays })
    .returning();

  res.status(201).json({
    id: created.id,
    name: created.name,
    isBaseline: created.isBaseline,
    stalenessThresholdDays: created.stalenessThresholdDays,
    createdAt: created.createdAt.toISOString(),
    lastUploadAt: null,
    lastUploadStatus: null,
  });
});

router.patch("/distributors/:id", requireElevatedRole, async (req, res): Promise<void> => {
  const params = UpdateDistributorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDistributorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { id } = params.data;
  const updates: Partial<typeof distributorsTable.$inferInsert> = {};

  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.stalenessThresholdDays !== undefined)
    updates.stalenessThresholdDays = parsed.data.stalenessThresholdDays;

  // If marking as baseline, unset existing baseline
  if (parsed.data.isBaseline === true) {
    await db.update(distributorsTable).set({ isBaseline: false }).where(eq(distributorsTable.isBaseline, true));
    updates.isBaseline = true;
  } else if (parsed.data.isBaseline === false) {
    updates.isBaseline = false;
  }

  if (Object.keys(updates).length === 0) {
    const [existing] = await db.select().from(distributorsTable).where(eq(distributorsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Distributor not found" });
      return;
    }
    res.json({ id: existing.id, name: existing.name, isBaseline: existing.isBaseline, stalenessThresholdDays: existing.stalenessThresholdDays, createdAt: existing.createdAt.toISOString(), lastUploadAt: null, lastUploadStatus: null });
    return;
  }

  const [updated] = await db.update(distributorsTable).set(updates).where(eq(distributorsTable.id, id)).returning();

  if (!updated) {
    res.status(404).json({ error: "Distributor not found" });
    return;
  }

  const [lastUpload] = await db
    .select()
    .from(uploadsTable)
    .where(eq(uploadsTable.distributorId, updated.id))
    .orderBy(desc(uploadsTable.uploadedAt))
    .limit(1);

  res.json({
    id: updated.id,
    name: updated.name,
    isBaseline: updated.isBaseline,
    stalenessThresholdDays: updated.stalenessThresholdDays,
    createdAt: updated.createdAt.toISOString(),
    lastUploadAt: lastUpload?.uploadedAt?.toISOString() ?? null,
    lastUploadStatus: lastUpload?.status ?? null,
  });
});

router.delete("/distributors/:id", requireElevatedRole, async (req, res): Promise<void> => {
  const params = DeleteDistributorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db.delete(distributorsTable).where(eq(distributorsTable.id, params.data.id)).returning();

  if (!deleted) {
    res.status(404).json({ error: "Distributor not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
