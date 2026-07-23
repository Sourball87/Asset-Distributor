import { Router } from "express";
import { db, brandsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateBrandBody,
  UpdateBrandBody,
  UpdateBrandParams,
  DeleteBrandParams,
} from "@workspace/api-zod";
import { requireAuth, requireElevatedRole } from "../middlewares/auth";

const router = Router();

router.get("/brands", requireAuth, async (req, res): Promise<void> => {
  const brands = await db.select().from(brandsTable).orderBy(brandsTable.canonicalName);
  res.json(brands.map((b) => ({
    id: b.id,
    canonicalName: b.canonicalName,
    aliases: b.aliases,
    referenceOnly: b.referenceOnly,
  })));
});

router.post("/brands", requireElevatedRole, async (req, res): Promise<void> => {
  const parsed = CreateBrandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(brandsTable)
    .values({
      canonicalName: parsed.data.canonicalName.toUpperCase(),
      aliases: parsed.data.aliases,
      referenceOnly: parsed.data.referenceOnly ?? false,
    })
    .returning();

  res.status(201).json({
    id: created.id,
    canonicalName: created.canonicalName,
    aliases: created.aliases,
    referenceOnly: created.referenceOnly,
  });
});

router.patch("/brands/:id", requireElevatedRole, async (req, res): Promise<void> => {
  const params = UpdateBrandParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateBrandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof brandsTable.$inferInsert> = {};
  if (parsed.data.canonicalName !== undefined) updates.canonicalName = parsed.data.canonicalName.toUpperCase();
  if (parsed.data.aliases !== undefined) updates.aliases = parsed.data.aliases;
  if (parsed.data.referenceOnly !== undefined) updates.referenceOnly = parsed.data.referenceOnly;

  const [updated] = await db
    .update(brandsTable)
    .set(updates)
    .where(eq(brandsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json({
    id: updated.id,
    canonicalName: updated.canonicalName,
    aliases: updated.aliases,
    referenceOnly: updated.referenceOnly,
  });
});

router.delete("/brands/:id", requireElevatedRole, async (req, res): Promise<void> => {
  const params = DeleteBrandParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(brandsTable)
    .where(eq(brandsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
