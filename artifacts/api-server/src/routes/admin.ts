import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { db, usersTable, pool } from "@workspace/db";
import { eq, ne, and, count } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import {
  UpdateAdminUserBody,
} from "@workspace/api-zod";

const router = Router();

router.use("/admin", requireAdmin);

router.get("/admin/users", async (req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      lastLoginAt: usersTable.lastLoginAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);

  res.json(users.map((u) => ({
    ...u,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  })));
});

router.patch("/admin/users/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const parsed = UpdateAdminUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { role, status } = parsed.data;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if ((role === "user" || role === "superuser") && existing.role === "admin") {
    const [{ value: adminCount }] = await db
      .select({ value: count() })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
    if (Number(adminCount) <= 1) {
      res.status(409).json({ error: "Cannot change the role of the last active admin." });
      return;
    }
  }

  const updateData: Partial<{ role: string; status: string }> = {};
  if (role !== undefined) updateData.role = role;
  if (status !== undefined) updateData.status = status;

  const [updated] = await db.update(usersTable).set(updateData).where(eq(usersTable.id, id)).returning();

  res.json({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    status: updated.status,
    createdAt: updated.createdAt.toISOString(),
  });
});

router.delete("/admin/users/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  if (id === req.session.userId) {
    res.status(409).json({ error: "You cannot delete your own account." });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (existing.role === "admin") {
    const [{ value: adminCount }] = await db
      .select({ value: count() })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
    if (Number(adminCount) <= 1) {
      res.status(409).json({ error: "Cannot delete the last active admin." });
      return;
    }
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.sendStatus(204);
});

router.post("/admin/users/:id/reset-password", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const [existing] = await db.select({ id: usersTable.id, status: usersTable.status }).from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const temporaryPassword = randomBytes(6).toString("base64url").slice(0, 10) + randomBytes(2).toString("hex").toUpperCase();
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, id));

  req.log.info({ adminId: req.session.userId, targetUserId: id }, "Admin reset user password");

  res.json({ temporaryPassword });
});

// ── POST /admin/maintenance/purge-upload ─────────────────────────────────────
// Purges all stock_snapshots for a given upload_id, deletes any products that
// become orphaned (no remaining snapshots), and marks the upload invalid.
// Use dryRun=true (default) to inspect impact before committing.
router.post("/admin/maintenance/purge-upload", async (req, res): Promise<void> => {
  const { uploadId, dryRun = true } = req.body as { uploadId: number; dryRun?: boolean };

  if (!uploadId || isNaN(Number(uploadId))) {
    res.status(400).json({ error: "uploadId is required" });
    return;
  }

  const id = Number(uploadId);

  // 1. Verify the upload exists
  type UploadRow = {
    id: number; snapshot_date: string; status: string;
    row_count_total: number; row_count_matched: number; distributor_id: number;
  };
  const { rows: [uploadRow] } = await pool.query<UploadRow>(
    `SELECT id, snapshot_date, status, row_count_total, row_count_matched, distributor_id
     FROM uploads WHERE id = $1`,
    [id],
  );
  if (!uploadRow) {
    res.status(404).json({ error: "Upload not found" });
    return;
  }

  // 2. Pre-flight: count snapshots and orphan products
  const { rows: [{ snap_count }] } = await pool.query<{ snap_count: string }>(
    `SELECT COUNT(*)::text AS snap_count FROM stock_snapshots WHERE upload_id = $1`,
    [id],
  );

  const { rows: [{ orphan_count }] } = await pool.query<{ orphan_count: string }>(`
    SELECT COUNT(*)::text AS orphan_count
    FROM (
      SELECT product_id
      FROM stock_snapshots
      WHERE distributor_id = $2
        AND product_id IN (SELECT DISTINCT product_id FROM stock_snapshots WHERE upload_id = $1)
      GROUP BY product_id
      HAVING SUM(CASE WHEN upload_id != $1 THEN 1 ELSE 0 END) = 0
    ) x`,
    [id, uploadRow.distributor_id],
  );

  const preflight = {
    uploadId: id,
    snapshotDate: uploadRow.snapshot_date,
    currentStatus: uploadRow.status,
    rowCountTotal: uploadRow.row_count_total,
    rowCountMatched: uploadRow.row_count_matched,
    snapshotsToDelete: Number(snap_count),
    orphanProductsToDelete: Number(orphan_count),
  };

  if (dryRun) {
    res.json({ dryRun: true, preflight });
    return;
  }

  // 3. Execute purge in a single transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount: deletedSnaps } = await client.query(
      `DELETE FROM stock_snapshots WHERE upload_id = $1`,
      [id],
    );

    const { rowCount: deletedProducts } = await client.query(`
      DELETE FROM products
      WHERE id NOT IN (SELECT DISTINCT product_id FROM stock_snapshots)
    `);

    await client.query(
      `UPDATE uploads SET status = 'invalid_mapping' WHERE id = $1`,
      [id],
    );

    // 4. Verify before COMMIT
    const { rows: [verify] } = await client.query<{
      remaining_snaps: string; zero_snap_products: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM stock_snapshots WHERE upload_id = $1) AS remaining_snaps,
        (SELECT COUNT(*)::text FROM products p
         WHERE NOT EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.product_id = p.id)
        ) AS zero_snap_products
    `, [id]);

    if (Number(verify.remaining_snaps) !== 0 || Number(verify.zero_snap_products) !== 0) {
      await client.query("ROLLBACK");
      res.status(500).json({
        error: "Verification failed — rolled back",
        remainingSnapsForUpload: Number(verify.remaining_snaps),
        productsWithZeroSnaps: Number(verify.zero_snap_products),
      });
      return;
    }

    await client.query("COMMIT");

    req.log.warn(
      { uploadId: id, deletedSnaps, deletedProducts },
      "Admin purged invalid upload",
    );

    res.json({
      dryRun: false,
      preflight,
      result: {
        deletedSnapshots: deletedSnaps,
        deletedOrphanProducts: deletedProducts,
        uploadMarkedInvalid: true,
        verified: { remainingSnapshotsForUpload: 0, productsWithZeroSnapshots: 0 },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    req.log.error({ err, uploadId: id }, "Purge upload failed");
    res.status(500).json({ error: "Purge failed — rolled back" });
  } finally {
    client.release();
  }
});

export default router;
