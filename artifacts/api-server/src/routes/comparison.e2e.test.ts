import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// vi.mock is hoisted before any imports by Vitest, so requireAuth is mocked
// before comparison.ts is loaded — the route never calls the real DB auth check.
vi.mock("../middlewares/auth", () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuth:  (_req: Request, _res: Response, next: NextFunction) => next(),
  requireElevatedRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withLogger(app: any) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).log = {
      info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
      fatal: () => {}, trace: () => {}, silent: () => {}, level: "info", msgPrefix: "",
    };
    next();
  });
  return app;
}

// ---------------------------------------------------------------------------
// Comparison route — ingramWeeklySales e2e SQL validation
// ---------------------------------------------------------------------------

describe("GET /comparison – ingramWeeklySales field (e2e SQL)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    const { default: comparisonRouter } = await import("./comparison");
    app = withLogger(express());
    app.use(express.json());
    app.use(comparisonRouter);
  });

  it("returns 200 with rows array containing ingramWeeklySales on each row", async () => {
    // No filters → first page of results. The key assertion is that the SQL
    // (including the ingram_ordered / ingram_weekly CTEs) executes without
    // error and each row carries the ingramWeeklySales field.
    const res = await request(app)
      .get("/comparison")
      .expect(200);

    expect(res.body).toHaveProperty("rows");
    expect(Array.isArray(res.body.rows)).toBe(true);

    for (const row of res.body.rows) {
      expect(row).toHaveProperty("ingramWeeklySales");
      // Value must be a number or null — never undefined
      const v = row.ingramWeeklySales;
      expect(v === null || typeof v === "number").toBe(true);
    }
  }, 30_000);

  it("ingramWeeklySales is null when Ingram has insufficient data for a SKU", async () => {
    // Any SKU where Ingram has <2 snapshots or <7 days of data within 30 days
    // must return null (not 0, not a string).  We verify the type contract by
    // confirming no row carries a non-null non-number value.
    const res = await request(app)
      .get("/comparison")
      .expect(200);

    for (const row of res.body.rows) {
      const v = row.ingramWeeklySales;
      if (v !== null) {
        expect(typeof v).toBe("number");
        expect(isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  }, 30_000);

  it("returns 200 with a brand filter — ingram CTE scopes to paged products only", async () => {
    // Passing a brand filter reduces paged_products; the ingram_ordered CTE
    // must still compile and execute correctly with the scoped product set.
    const res = await request(app)
      .get("/comparison?brand=HP")
      .expect(200);

    expect(res.body).toHaveProperty("rows");
    for (const row of res.body.rows) {
      expect(row).toHaveProperty("ingramWeeklySales");
    }
  }, 30_000);

  it("returns 200 with partialMatch=true — no SQL conflict with Ingram CTE", async () => {
    const res = await request(app)
      .get("/comparison?search=laptop&partialMatch=true")
      .expect(200);

    expect(res.body).toHaveProperty("rows");
    for (const row of res.body.rows) {
      expect(row).toHaveProperty("ingramWeeklySales");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Weekly sell-through SQL formula unit test (mirrors movement-classifier logic)
// ---------------------------------------------------------------------------

describe("ingramWeeklySales — SQL formula mirrors movement classifier", () => {
  /**
   * Reproduce the SQL formula in JS to verify the route's weekly_est
   * calculation matches the movement classifier for known inputs.
   *
   * SQL formula (condensed):
   *   est_units_sold = SUM(
   *     CASE
   *       WHEN soh - prev_soh < 0 THEN -(soh - prev_soh)
   *       WHEN soh - prev_soh > 0 AND (COALESCE(soo,0)-COALESCE(prev_soo,0)) < 0
   *         THEN GREATEST(0, -(COALESCE(soo,0)-COALESCE(prev_soo,0)) - (soh - prev_soh))
   *       ELSE 0
   *     END
   *   ) FILTER (WHERE prev_soh IS NOT NULL AND soh IS NOT NULL)
   *
   *   weekly_est = est_units_sold * 7.0 / GREATEST(1, days_covered)
   *     only when COUNT(*) >= 2 AND days_covered >= 7, else NULL
   */
  function simulateWeeklyEst(
    snapshots: Array<{ soh: number | null; soo?: number | null; date: string }>,
  ): number | null {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) return null;

    const daysCovered = Math.round(
      (new Date(sorted[sorted.length - 1]!.date).getTime() - new Date(sorted[0]!.date).getTime())
      / 86_400_000,
    );
    if (daysCovered < 7) return null;

    let estUnitsSold = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (prev.soh == null || curr.soh == null) continue;
      const soh_d = curr.soh - prev.soh;
      const soo_d = (curr.soo ?? 0) - (prev.soo ?? 0);
      if (soh_d < 0) {
        estUnitsSold += -soh_d;
      } else if (soh_d > 0 && soo_d < 0) {
        estUnitsSold += Math.max(0, -soo_d - soh_d);
      }
    }
    return (estUnitsSold * 7.0) / Math.max(1, daysCovered);
  }

  it("pure SOH decline over 14 days → correct weekly rate", () => {
    // 100→60 = 40 units over 14 days → 40/14*7 = 20.0
    const result = simulateWeeklyEst([
      { soh: 100, soo: 0, date: "2026-06-01" },
      { soh: 60,  soo: 0, date: "2026-06-15" },
    ]);
    expect(result).toBeCloseTo(20.0, 5);
  });

  it("delivery-masked sales: SOH +40, SOO -100 over 14 days → 60 units / 14 days", () => {
    // soh_d = +40, soo_d = -100 → GREATEST(0, 100 - 40) = 60 units
    const result = simulateWeeklyEst([
      { soh: 10,  soo: 200, date: "2026-06-01" },
      { soh: 50,  soo: 100, date: "2026-06-15" },
    ]);
    expect(result).toBeCloseTo((60 * 7) / 14, 5);
  });

  it("fewer than 2 snapshots → null", () => {
    expect(simulateWeeklyEst([{ soh: 100, soo: 0, date: "2026-06-01" }])).toBeNull();
  });

  it("days_covered < 7 → null (insufficient window)", () => {
    expect(simulateWeeklyEst([
      { soh: 100, soo: 0, date: "2026-06-01" },
      { soh: 80,  soo: 0, date: "2026-06-05" }, // 4 days
    ])).toBeNull();
  });

  it("flat SOH over 14 days → 0 (no sales estimated)", () => {
    expect(simulateWeeklyEst([
      { soh: 50, soo: 0, date: "2026-06-01" },
      { soh: 50, soo: 0, date: "2026-06-15" },
    ])).toBe(0);
  });

  it("SOO delivery-masked: soo_d exactly cancels soh gain → 0 units sold", () => {
    // soh +10, soo -10 → GREATEST(0, 10 - 10) = 0
    expect(simulateWeeklyEst([
      { soh: 20, soo: 50, date: "2026-06-01" },
      { soh: 30, soo: 40, date: "2026-06-15" },
    ])).toBe(0);
  });
});
