import { pgTable, serial, timestamp, integer, text, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { distributorsTable } from "./distributors";

export const importProfilesTable = pgTable("import_profiles", {
  id: serial("id").primaryKey(),
  distributorId: integer("distributor_id").notNull().references(() => distributorsTable.id, { onDelete: "cascade" }).unique(),
  sourceFormat: text("source_format", { enum: ["xlsx", "txt"] }).notNull(),
  delimiter: text("delimiter"),
  headerRowIndex: integer("header_row_index").notNull().default(0),
  mapping: jsonb("mapping").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertImportProfileSchema = createInsertSchema(importProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertImportProfile = z.infer<typeof insertImportProfileSchema>;
export type ImportProfile = typeof importProfilesTable.$inferSelect;
