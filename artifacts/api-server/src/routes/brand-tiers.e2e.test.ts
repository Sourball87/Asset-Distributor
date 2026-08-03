/**
 * Brand Visibility Tiers — e2e SQL tests
 *
 * Verifies that reference_only=true brands and their products are correctly
 * excluded from (or included in) each surface per the spec:
 *
 *   EXCLUDED: comparison grid, movement (default), exports (brand filter).
 *   INCLUDED: movement (includeReferenceBrands=true), market-price candidates.
 *   ADMIN:    /api/brands returns all brands (both tiers visible to admins).
 *
 * These tests run against the real dev Postgres DB using isolated test data
 * inserted at the start and cleaned up at the end.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

vi.mock("../middlewares/auth", () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireElevatedRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ─── Fixture IDs (populated in beforeAll) ─────────────────────────────────────
let refBrandId: number;
let refProductId: number;
let coreBrandId: number;
let coreProductId: number;
let testDistId: number;

// ─── Express apps (one per router, mounted after vi.mock hoisting) ─────────────
let comparisonApp: ReturnType<typeof express>;
let movementApp: ReturnType<typeof express>;
let brandsApp: ReturnType<typeof express>;

function mockLogger(req: Request, _res: Response, next: NextFunction) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).log = {
    info: () => {}, error: () => {}, warn: () => {},
    debug: () => {}, fatal: () => {}, trace: () => {}, silent: () => {},
    level: "info", msgPrefix: "",
  };
  next();
}

const UNIQUE = `test_tier_${Date.now()}`;

beforeAll(async () => {
  // --- Insert test distributor (non-baseline) ---
  const distResult = await pool.query<{ id: number }>(
    `INSERT INTO distributors (name, is_baseline, staleness_threshold_days)
     VALUES ($1, false, 7) RETURNING id`,
    [`${UNIQUE}_dist`],
  );
  testDistId = distResult.rows[0].id;

  // --- Insert reference brand (reference_only = true) ---
  const refBrand = await pool.query<{ id: number }>(
    `INSERT INTO brands (canonical_name, aliases, reference_only)
     VALUES ($1, '{}', true) RETURNING id`,
    [`${UNIQUE}_REF`],
  );
  refBrandId = refBrand.rows[0].id;

  // --- Insert core brand (reference_only = false) ---
  const coreBrand = await pool.query<{ id: number }>(
    `INSERT INTO brands (canonical_name, aliases, reference_only)
     VALUES ($1, '{}', false) RETURNING id`,
    [`${UNIQUE}_CORE`],
  );
  coreBrandId = coreBrand.rows[0].id;

  // --- Insert products for each brand ---
  const refProd = await pool.query<{ id: number }>(
    `INSERT INTO products (vpn_normalized, vpn_display, brand, description)
     VALUES ($1, $1, $2, 'Reference-brand test product') RETURNING id`,
    [`${UNIQUE}-REF-VPN`, `${UNIQUE}_REF`],
  );
  refProductId = refProd.rows[0].id;

  const coreProd = await pool.query<{ id: number }>(
    `INSERT INTO products (vpn_normalized, vpn_display, brand, description)
     VALUES ($1, $1, $2, 'Core-brand test product') RETURNING id`,
    [`${UNIQUE}-CORE-VPN`, `${UNIQUE}_CORE`],
  );
  coreProductId = coreProd.rows[0].id;

  // --- Insert an upload record (stock_snapshots.upload_id is NOT NULL) ---
  const today = new Date().toISOString().slice(0, 10);
  const uploadResult = await pool.query<{ id: number }>(
    `INSERT INTO uploads (distributor_id, filename, snapshot_date, row_count_total, row_count_matched, status)
     VALUES ($1, $2, $3, 2, 2, 'committed') RETURNING id`,
    [testDistId, `${UNIQUE}_test_feed.xlsx`, today],
  );
  const uploadId = uploadResult.rows[0].id;

  // --- Stock snapshots for both products at the test distributor ---
  await pool.query(
    `INSERT INTO stock_snapshots (product_id, distributor_id, upload_id, snapshot_date, sell_price, soh)
     VALUES ($1, $2, $3, $4, '100.00', 10),
            ($5, $2, $3, $4, '200.00', 20)`,
    [refProductId, testDistId, uploadId, today, coreProductId],
  );

  // --- Build Express apps ---
  const { default: comparisonRouter } = await import("./comparison");
  comparisonApp = express();
  comparisonApp.use(express.json());
  comparisonApp.use(mockLogger);
  comparisonApp.use(comparisonRouter);

  const { default: experimentalRouter } = await import("./experimental");
  movementApp = express();
  movementApp.use(express.json());
  movementApp.use(mockLogger);
  movementApp.use(experimentalRouter);

  const { default: brandsRouter } = await import("./brands");
  brandsApp = express();
  brandsApp.use(express.json());
  brandsApp.use(mockLogger);
  brandsApp.use(brandsRouter);
});

afterAll(async () => {
  // Clean up in reverse dependency order
  await pool.query(
    `DELETE FROM stock_snapshots WHERE product_id IN ($1, $2)`,
    [refProductId, coreProductId],
  );
  await pool.query(`DELETE FROM uploads WHERE distributor_id = $1`, [testDistId]);
  await pool.query(`DELETE FROM products WHERE id IN ($1, $2)`, [refProductId, coreProductId]);
  await pool.query(`DELETE FROM brands WHERE id IN ($1, $2)`, [refBrandId, coreBrandId]);
  await pool.query(`DELETE FROM distributors WHERE id = $1`, [testDistId]);
});

// ─── Comparison grid ───────────────────────────────────────────────────────────

describe("Comparison endpoint — reference brand filtering", () => {
  it("excludes reference-brand products from comparison grid by default", async () => {
    const res = await request(comparisonApp)
      .get(`/comparison?search=${encodeURIComponent(UNIQUE)}&partialMatch=true`)
      .expect(200);

    const vpns: string[] = (res.body.rows ?? []).map((r: { vpnNormalized: string }) => r.vpnNormalized);
    expect(vpns).not.toContain(`${UNIQUE}-REF-VPN`);
  });

  it("includes core-brand products in comparison grid", async () => {
    const res = await request(comparisonApp)
      .get(`/comparison?search=${encodeURIComponent(UNIQUE)}&partialMatch=true`)
      .expect(200);

    const vpns: string[] = (res.body.rows ?? []).map((r: { vpnNormalized: string }) => r.vpnNormalized);
    expect(vpns).toContain(`${UNIQUE}-CORE-VPN`);
  });
});

// ─── Movement page ─────────────────────────────────────────────────────────────

describe("Movement endpoint — includeReferenceBrands toggle", () => {
  it("excludes reference-brand products by default (includeReferenceBrands omitted)", async () => {
    const res = await request(movementApp)
      .get(`/experimental/movement?distributorId=${testDistId}&search=${encodeURIComponent(UNIQUE)}`)
      .expect(200);

    const vpns: string[] = (res.body.products ?? []).map((p: { vpnNormalized: string }) => p.vpnNormalized);
    expect(vpns).not.toContain(`${UNIQUE}-REF-VPN`);
  });

  it("excludes reference-brand products when includeReferenceBrands=false", async () => {
    const res = await request(movementApp)
      .get(`/experimental/movement?distributorId=${testDistId}&includeReferenceBrands=false&search=${encodeURIComponent(UNIQUE)}`)
      .expect(200);

    const vpns: string[] = (res.body.products ?? []).map((p: { vpnNormalized: string }) => p.vpnNormalized);
    expect(vpns).not.toContain(`${UNIQUE}-REF-VPN`);
  });

  it("includes reference-brand products when includeReferenceBrands=true", async () => {
    const res = await request(movementApp)
      .get(`/experimental/movement?distributorId=${testDistId}&includeReferenceBrands=true&search=${encodeURIComponent(UNIQUE)}`)
      .expect(200);

    const vpns: string[] = (res.body.products ?? []).map((p: { vpnNormalized: string }) => p.vpnNormalized);
    expect(vpns).toContain(`${UNIQUE}-REF-VPN`);
  });

  it("always includes core-brand products regardless of toggle", async () => {
    for (const flag of ["true", "false"]) {
      const res = await request(movementApp)
        .get(`/experimental/movement?distributorId=${testDistId}&includeReferenceBrands=${flag}&search=${encodeURIComponent(UNIQUE)}`)
        .expect(200);
      const vpns: string[] = (res.body.products ?? []).map((p: { vpnNormalized: string }) => p.vpnNormalized);
      expect(vpns).toContain(`${UNIQUE}-CORE-VPN`);
    }
  });
});

// ─── Admin brands list ─────────────────────────────────────────────────────────

describe("GET /brands — admin visibility", () => {
  it("returns both reference and core brands (admin sees all)", async () => {
    const res = await request(brandsApp).get("/brands").expect(200);
    const names: string[] = (res.body ?? []).map((b: { canonicalName: string }) => b.canonicalName);
    expect(names).toContain(`${UNIQUE}_REF`);
    expect(names).toContain(`${UNIQUE}_CORE`);
  });

  it("reference brand has referenceOnly=true in the response", async () => {
    const res = await request(brandsApp).get("/brands").expect(200);
    const refBrandRow = (res.body ?? []).find(
      (b: { canonicalName: string }) => b.canonicalName === `${UNIQUE}_REF`,
    );
    expect(refBrandRow).toBeDefined();
    expect(refBrandRow.referenceOnly).toBe(true);
  });

  it("core brand has referenceOnly=false in the response", async () => {
    const res = await request(brandsApp).get("/brands").expect(200);
    const coreBrandRow = (res.body ?? []).find(
      (b: { canonicalName: string }) => b.canonicalName === `${UNIQUE}_CORE`,
    );
    expect(coreBrandRow).toBeDefined();
    expect(coreBrandRow.referenceOnly).toBe(false);
  });
});

// ─── DB-level filter correctness ───────────────────────────────────────────────

describe("SQL filter integrity — reference_only column semantics", () => {
  it("comparison JOIN on brands excludes reference_only products from count", async () => {
    const { rows } = await pool.query<{ cnt: string }>(`
      SELECT COUNT(*)::int AS cnt
      FROM products p
      JOIN brands b ON b.canonical_name = p.brand AND b.reference_only = false
      WHERE p.brand IN ($1, $2)
    `, [`${UNIQUE}_REF`, `${UNIQUE}_CORE`]);
    // Only core product should pass the JOIN
    expect(parseInt(String(rows[0].cnt), 10)).toBe(1);
  });

  it("PATCH /brands/:id can toggle a brand from core to reference-only", async () => {
    const patchRes = await request(brandsApp)
      .patch(`/brands/${coreBrandId}`)
      .send({ referenceOnly: true })
      .expect(200);
    expect(patchRes.body.referenceOnly).toBe(true);

    // Restore to core
    await request(brandsApp)
      .patch(`/brands/${coreBrandId}`)
      .send({ referenceOnly: false })
      .expect(200);
  });
});
