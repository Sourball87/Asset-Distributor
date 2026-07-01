import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function requireElevatedRole(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  db.select({ role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId))
    .then(([user]) => {
      if (!user || user.status !== "active" || user.role === "user") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    })
    .catch((err) => {
      req.log.error({ err }, "requireElevatedRole DB error");
      res.status(500).json({ error: "Internal server error" });
    });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  db.select({ role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId))
    .then(([user]) => {
      if (!user || user.role !== "admin" || user.status !== "active") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    })
    .catch((err) => {
      req.log.error({ err }, "requireAdmin DB error");
      res.status(500).json({ error: "Internal server error" });
    });
}
