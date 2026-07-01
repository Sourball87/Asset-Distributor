import { pgTable, serial, timestamp, integer, text, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { distributorsTable } from "./distributors";
import { usersTable } from "./users";

export const uploadsTable = pgTable("uploads", {
  id: serial("id").primaryKey(),
  distributorId: integer("distributor_id").notNull().references(() => distributorsTable.id),
  filename: text("filename").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
  rowCountTotal: integer("row_count_total").notNull().default(0),
  rowCountMatched: integer("row_count_matched").notNull().default(0),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  status: text("status", { enum: ["parsing", "mapped", "committed", "failed"] }).notNull().default("parsing"),
});

export const insertUploadSchema = createInsertSchema(uploadsTable).omit({ id: true, uploadedAt: true });
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploadsTable.$inferSelect;
