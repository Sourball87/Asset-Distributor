import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { db, usersTable } from "@workspace/db";
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

export default router;
