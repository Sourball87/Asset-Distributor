import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { productsTable } from "./products";

export const marketPriceCacheTable = pgTable("market_price_cache", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").references(() => productsTable.id),
  queryHash: text("query_hash").notNull(),
  requestSummary: text("request_summary").notNull(),
  responseJson: jsonb("response_json").notNull(),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_mpc_query_hash").on(t.queryHash),
]);

export type MarketPriceCache = typeof marketPriceCacheTable.$inferSelect;

// Daily cap counter — one row per UTC date, incremented atomically
export const marketPriceLlmCallsTable = pgTable("market_price_llm_calls", {
  id: serial("id").primaryKey(),
  callDate: text("call_date").notNull().unique(), // YYYY-MM-DD UTC
  callCount: integer("call_count").notNull().default(0),
});
