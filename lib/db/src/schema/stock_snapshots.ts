import { pgTable, serial, timestamp, integer, numeric, date, text, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { uploadsTable } from "./uploads";
import { distributorsTable } from "./distributors";
import { productsTable } from "./products";

export const stockSnapshotsTable = pgTable("stock_snapshots", {
  id: serial("id").primaryKey(),
  uploadId: integer("upload_id").notNull().references(() => uploadsTable.id),
  distributorId: integer("distributor_id").notNull().references(() => distributorsTable.id),
  productId: integer("product_id").notNull().references(() => productsTable.id),
  snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
  sellPrice: numeric("sell_price", { precision: 12, scale: 2 }),
  soh: integer("soh"),
  soo: integer("soo"),
  category: text("category"),
  skuType: text("sku_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_ss_distributor_id").on(t.distributorId),
  index("idx_ss_product_id").on(t.productId),
  index("idx_ss_product_distributor").on(t.productId, t.distributorId),
  index("idx_ss_upload_id").on(t.uploadId),
  index("idx_ss_snapshot_date").on(t.snapshotDate),
]);

export const insertStockSnapshotSchema = createInsertSchema(stockSnapshotsTable).omit({ id: true, createdAt: true });
export type InsertStockSnapshot = z.infer<typeof insertStockSnapshotSchema>;
export type StockSnapshot = typeof stockSnapshotsTable.$inferSelect;
