import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// vi.mock is hoisted before any imports by Vitest, so requireAdmin is mocked
// before experimental.ts is loaded — the route never calls the real DB auth check.
vi.mock("../middlewares/auth", () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireElevatedRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("GET /experimental/movement – e2e SQL validation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    // Dynamic import runs AFTER vi.mock hoisting so the mocked middleware is in place.
    const { default: experimentalRouter } = await import("./experimental");

    app = express();
    app.use(express.json());

    // Inject a no-op pino logger onto req so req.log.* calls in the route don't crash.
    // (pino-http normally does this; here we bypass app.ts and mount the router directly.)
    // Cast through unknown to avoid satisfying the full pino Logger interface in tests.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, silent: () => {}, level: "info", msgPrefix: "" };
      next();
    });

    app.use(experimentalRouter);
  });

  it("soldOutOnly=true returns 200 — HAVING clause SQL is valid", async () => {
    // distributorId=2 is Ingram Micro (non-baseline, has snapshot data in dev DB).
    // The critical path: soldOutOnly=true causes a HAVING clause that embeds the
    // estUnitsSold formula. Before the fix this used queryChunks.join("") which
    // produced invalid SQL and caused a 500.
    const res = await request(app)
      .get("/experimental/movement?distributorId=2&soldOutOnly=true")
      .expect(200);

    expect(res.body).toHaveProperty("products");
    expect(Array.isArray(res.body.products)).toBe(true);
  });

  it("soldOutOnly=false (default) also returns 200", async () => {
    const res = await request(app)
      .get("/experimental/movement?distributorId=2")
      .expect(200);

    expect(res.body).toHaveProperty("products");
    expect(res.body).toHaveProperty("dataQuality");
  });
});

describe("Bundle filter SQL – NULL-safety (Ingram-shaped fixture)", () => {
  // Ingram has sku_type = NULL for every row. This test proves that non-bundle
  // Ingram products (null sku_type + non-bundle vpn_display) are included when
  // excludeBundles=true — i.e. the COALESCE guard prevents NOT NULL from silently
  // dropping them.
  //
  // The bundle filter SQL used by the route:
  //
  //   NOT COALESCE(
  //     CASE
  //       WHEN ss.sku_type IS NOT NULL AND ss.sku_type != ''
  //       THEN ss.sku_type = 'BundledItem'
  //       ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
  //     END,
  //     FALSE                  ← NULL-safe fallback: treat null vpn_display as non-bundle
  //   )

  it("null sku_type + non-bundle VPN counts are identical with/without COALESCE guard", async () => {
    // Count Ingram non-bundle products (null sku_type, heuristic-negative vpn_display).
    // These are the rows at risk of being dropped if the CASE produces NULL.
    const baseline = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(DISTINCT p.id) AS cnt
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      JOIN distributors d ON d.id = ss.distributor_id
      WHERE d.name ILIKE '%ingram%'
        AND ss.sku_type IS NULL
        AND NOT (p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0)
    `);
    const expectedCount = parseInt(String(baseline.rows[0]?.cnt ?? "0"), 10);
    expect(expectedCount).toBeGreaterThan(0); // sanity: such products exist

    // Apply the full COALESCE-wrapped bundle filter and keep only null-sku_type rows.
    // With the fix in place this must equal expectedCount (no rows silently dropped).
    const withFilter = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(DISTINCT p.id) AS cnt
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      JOIN distributors d ON d.id = ss.distributor_id
      WHERE d.name ILIKE '%ingram%'
        AND ss.sku_type IS NULL
        AND NOT COALESCE(
          CASE
            WHEN ss.sku_type IS NOT NULL AND ss.sku_type != ''
            THEN ss.sku_type = 'BundledItem'
            ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
          END,
          FALSE
        )
    `);
    const filteredCount = parseInt(String(withFilter.rows[0]?.cnt ?? "0"), 10);

    // Must match exactly: the COALESCE guard means NULL vpn_display rows are treated
    // as non-bundles (FALSE) and included, not silently dropped.
    expect(filteredCount).toBe(expectedCount);
  });

  it("CASE expression produces zero NULL rows for Ingram (null probe)", async () => {
    // Directly asserts the CASE can never yield NULL for any current Ingram row,
    // confirming no rows are at risk. Fails fast if future feed changes introduce nulls.
    const probe = await db.execute<{ null_count: string }>(sql`
      SELECT COUNT(*) AS null_count
      FROM stock_snapshots ss
      JOIN products p ON p.id = ss.product_id
      JOIN distributors d ON d.id = ss.distributor_id
      WHERE d.name ILIKE '%ingram%'
        AND (
          CASE
            WHEN ss.sku_type IS NOT NULL AND ss.sku_type != ''
            THEN ss.sku_type = 'BundledItem'
            ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
          END
        ) IS NULL
    `);
    const nullCount = parseInt(String(probe.rows[0]?.null_count ?? "0"), 10);
    expect(nullCount).toBe(0);
  });
});
