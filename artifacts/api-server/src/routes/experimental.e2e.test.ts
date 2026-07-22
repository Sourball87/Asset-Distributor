import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";

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
