/**
 * E2E tests for upload replace semantics and SOH value storage.
 *
 * Scenarios covered:
 *  1. SOH=0 is stored as integer 0 (not null) after commit
 *  2. SOH=-5 (negative) is stored with correct sign (not null)
 *  3. Re-committing the same distributor+date replaces snapshots (no duplicates)
 *  4. Comparison API returns soh: 0 (not null) for zero-stock product
 *
 * The test creates its own admin user in beforeAll and removes it in afterAll
 * so it does not depend on any pre-existing credentials.
 */

import { test, expect, APIRequestContext, request as makeRequest } from "@playwright/test";
import { randomBytes } from "crypto";
import pg from "pg";

// ── Test admin credentials (created/destroyed within this suite) ────────────
const TEST_ADMIN_EMAIL = "e2e-upload-admin@distibench.test";
const TEST_ADMIN_PASSWORD = "E2eTestPass99!";
// bcrypt hash of TEST_ADMIN_PASSWORD (cost 10).
const TEST_ADMIN_HASH =
  "$2b$10$Mbs8DXj/FwdNZ8NOLFZi7ehio9IKGO3n5fNJ2QgmnfQNvQJLvMfTe";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const API_BASE = devDomain ? `https://${devDomain}` : "http://localhost:80";

// Snapshot date far in the future to avoid colliding with real data.
const TEST_DATE = "2099-06-15";

// Dicker Data distributor (id=1, is_baseline=true, seeded in DB).
const DICKER_DIST_ID = 1;

// VPN suffix unique per test run (8 hex chars) so cleanup is isolated
// when the same suite is run concurrently or repeatedly.
function uid(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

// Build a Dicker Data–format CSV with three rows:
//   ZERO row: SOH = 0   (key correctness check)
//   NEG  row: SOH = -5  (sign preservation check)
//   POS  row: SOH = 100 (sanity check)
function buildCsv(suffix: string): string {
  return [
    "StockCode,VendorStockCode,DealerEx,StockAvailable,StockDescription,Vendor",
    `DD-Z,TST-ZERO-${suffix},10.00,0,Test Zero SOH ${suffix},SAMSUNG`,
    `DD-N,TST-NEG-${suffix},15.00,-5,Test Negative SOH ${suffix},SAMSUNG`,
    `DD-P,TST-POS-${suffix},20.00,100,Test Positive SOH ${suffix},SAMSUNG`,
  ].join("\n");
}

// Dicker Data column mapping.
const DICKER_MAPPING = {
  vpn: "VendorStockCode",
  brand: "Vendor",
  description: "StockDescription",
  sell_price: "DealerEx",
  soh: "StockAvailable",
  soo: null,
};

// ── DB helpers ────────────────────────────────────────────────────────────────

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createTestAdmin(): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO users (email, password_hash, role, status, name)
       VALUES ($1, $2, 'admin', 'active', 'E2E Upload Test Admin')
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role          = EXCLUDED.role,
             status        = EXCLUDED.status`,
      [TEST_ADMIN_EMAIL, TEST_ADMIN_HASH],
    );
  });
}

async function deleteTestAdmin(): Promise<void> {
  await withDb(async (client) => {
    await client.query(`DELETE FROM users WHERE email = $1`, [TEST_ADMIN_EMAIL]);
  });
}

async function dbSnapshotRows(
  suffix: string,
): Promise<Array<{ vpn_normalized: string; soh: number | null }>> {
  return withDb(async (client) => {
    const vpns = [`TST-ZERO-${suffix}`, `TST-NEG-${suffix}`, `TST-POS-${suffix}`];
    const { rows } = await client.query<{ vpn_normalized: string; soh: number | null }>(
      `SELECT p.vpn_normalized, ss.soh
       FROM stock_snapshots ss
       JOIN products p ON p.id = ss.product_id
       WHERE p.vpn_normalized = ANY($1)
         AND ss.snapshot_date = $2
         AND ss.distributor_id = $3
       ORDER BY p.vpn_normalized`,
      [vpns, TEST_DATE, DICKER_DIST_ID],
    );
    return rows;
  });
}

async function dbCleanup(suffix: string): Promise<void> {
  await withDb(async (client) => {
    const vpns = [`TST-ZERO-${suffix}`, `TST-NEG-${suffix}`, `TST-POS-${suffix}`];
    await client.query(
      `DELETE FROM stock_snapshots
       WHERE product_id IN (SELECT id FROM products WHERE vpn_normalized = ANY($1))`,
      [vpns],
    );
    await client.query(`DELETE FROM products WHERE vpn_normalized = ANY($1)`, [vpns]);
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function getAdminApi(): Promise<APIRequestContext> {
  const ctx = await makeRequest.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", {
    data: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Admin login failed: ${res.status()} ${await res.text()}`);
  }
  return ctx;
}

async function parseCsv(
  ctx: APIRequestContext,
  csv: string,
  filename: string,
): Promise<string> {
  const res = await ctx.post("/api/uploads/parse", {
    multipart: {
      file: {
        name: filename,
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      },
      headerRowIndex: "0",
    },
  });
  if (!res.ok()) {
    throw new Error(`/uploads/parse failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.tempFileKey) throw new Error("No tempFileKey returned from /uploads/parse");
  return body.tempFileKey as string;
}

async function commitUpload(
  ctx: APIRequestContext,
  tempFileKey: string,
): Promise<{ rowCountMatched: number }> {
  const res = await ctx.post("/api/uploads/commit", {
    data: {
      distributorId: DICKER_DIST_ID,
      tempFileKey,
      snapshotDate: TEST_DATE,
      mapping: DICKER_MAPPING,
      sourceFormat: "csv",
      delimiter: ",",
    },
  });
  if (!res.ok()) {
    throw new Error(`/uploads/commit failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

test.beforeAll(async () => {
  await createTestAdmin();
});

test.afterAll(async () => {
  await deleteTestAdmin();
});

// ── Test 1 + 4 ────────────────────────────────────────────────────────────────
// SOH=0 stored as integer 0 (not null); SOH=-5 sign preserved;
// comparison API returns soh: 0 for the zero-stock product.
// ─────────────────────────────────────────────────────────────────────────────

test("SOH=0 is stored as integer 0 and returned as 0 by comparison API; SOH=-5 preserved", async () => {
  const suffix = uid();
  const csv = buildCsv(suffix);
  const ctx = await getAdminApi();

  try {
    // Parse + commit the CSV.
    const tempFileKey = await parseCsv(ctx, csv, `dicker-soh-${suffix}.csv`);
    const { rowCountMatched } = await commitUpload(ctx, tempFileKey);
    expect(rowCountMatched).toBe(3);

    // ── DB assertion: SOH values are correct ─────────────────────────────────
    const rows = await dbSnapshotRows(suffix);
    expect(rows).toHaveLength(3);

    const zeroRow = rows.find((r) => r.vpn_normalized === `TST-ZERO-${suffix}`);
    const negRow  = rows.find((r) => r.vpn_normalized === `TST-NEG-${suffix}`);
    const posRow  = rows.find((r) => r.vpn_normalized === `TST-POS-${suffix}`);

    expect(zeroRow).toBeDefined();
    expect(negRow).toBeDefined();
    expect(posRow).toBeDefined();

    // SOH=0 must be stored as 0, not null (critical — was a bug).
    expect(zeroRow!.soh).toBe(0);
    // SOH=-5 must preserve the negative sign.
    expect(negRow!.soh).toBe(-5);
    // SOH=100 sanity check.
    expect(posRow!.soh).toBe(100);

    // ── API assertion: comparison route returns soh=0, not null ──────────────
    const compRes = await ctx.get(
      `/api/comparison?brand=SAMSUNG&search=TST-ZERO-${suffix}`,
    );
    expect(compRes.ok()).toBeTruthy();

    type DistEntry = { distributorId: number; soh: number | null };
    type ProductRow = { vpnNormalized: string; distributors: DistEntry[] };
    const compBody = await compRes.json() as { rows: ProductRow[] };

    const product = compBody.rows.find(
      (p) => p.vpnNormalized === `TST-ZERO-${suffix}`,
    );
    expect(product).toBeDefined();

    const distEntry = product!.distributors.find(
      (d) => d.distributorId === DICKER_DIST_ID,
    );
    expect(distEntry).toBeDefined();
    // soh must be exactly 0 — not null, not undefined.
    expect(distEntry!.soh).toBe(0);
  } finally {
    await dbCleanup(suffix);
    await ctx.dispose();
  }
});

// ── Test 2 + 3 ────────────────────────────────────────────────────────────────
// Re-committing the same distributor+date replaces snapshots without duplicates.
// ─────────────────────────────────────────────────────────────────────────────

test("re-committing same distributor+date replaces snapshots — no duplicate rows", async () => {
  const suffix = uid();
  const csv = buildCsv(suffix);
  const ctx = await getAdminApi();

  try {
    // First commit.
    const key1 = await parseCsv(ctx, csv, `dicker-reupload-${suffix}.csv`);
    await commitUpload(ctx, key1);

    // Must have exactly 3 rows after first commit.
    const afterFirst = await dbSnapshotRows(suffix);
    expect(afterFirst).toHaveLength(3);

    // Second commit — same distributor, same snapshot date.
    const key2 = await parseCsv(ctx, csv, `dicker-reupload-${suffix}-v2.csv`);
    await commitUpload(ctx, key2);

    // Must still be exactly 3 rows (not 6) — replace semantics confirmed.
    const afterSecond = await dbSnapshotRows(suffix);
    expect(afterSecond).toHaveLength(3);

    // SOH values must be unchanged after the re-upload.
    const zeroRow = afterSecond.find((r) => r.vpn_normalized === `TST-ZERO-${suffix}`);
    const negRow  = afterSecond.find((r) => r.vpn_normalized === `TST-NEG-${suffix}`);
    expect(zeroRow!.soh).toBe(0);
    expect(negRow!.soh).toBe(-5);
  } finally {
    await dbCleanup(suffix);
    await ctx.dispose();
  }
});
