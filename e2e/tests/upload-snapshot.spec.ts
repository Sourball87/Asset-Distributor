/**
 * E2E tests for upload replace semantics, SOH value storage, and VPN
 * normalisation behaviour.
 *
 * Scenarios covered:
 *  1. SOH=0 is stored as integer 0 (not null) after commit
 *  2. SOH=-5 (negative) is stored with correct sign (not null)
 *  3. Re-committing the same distributor+date replaces snapshots (no duplicates)
 *  4. Comparison API returns soh: 0 (not null) for zero-stock product
 *  5. Two uploads with different VPN formats (hyphen vs space) normalise to one
 *     product and the latest price wins
 *  6. U-POE+ and U-POE++ committed together remain two separate products
 *     (+ is preserved in normalisation)
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

// Build a Dicker Data–format CSV using the StockCode column as VPN.
// VPN values are alphanumeric-only (no hyphens) so vpn_normalized === VPN.
//   ZERO row: SOH = 0   (key correctness check)
//   NEG  row: SOH = -5  (sign preservation check)
//   POS  row: SOH = 100 (sanity check)
function buildCsv(suffix: string): string {
  return [
    "StockCode,Vendor,DealerEx,StockAvailable,StockDescription",
    `TSTZERO${suffix},SAMSUNG,10.00,0,Test Zero SOH ${suffix}`,
    `TSTNEG${suffix},SAMSUNG,15.00,-5,Test Negative SOH ${suffix}`,
    `TSTPOS${suffix},SAMSUNG,20.00,100,Test Positive SOH ${suffix}`,
  ].join("\n");
}

// Dicker Data column mapping — vpn maps to StockCode (correct column).
const DICKER_MAPPING = {
  vpn: "StockCode",
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
    const vpns = [`TSTZERO${suffix}`, `TSTNEG${suffix}`, `TSTPOS${suffix}`];
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
    const vpns = [`TSTZERO${suffix}`, `TSTNEG${suffix}`, `TSTPOS${suffix}`];
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
  mapping = DICKER_MAPPING,
): Promise<{ rowCountMatched: number }> {
  const res = await ctx.post("/api/uploads/commit", {
    data: {
      distributorId: DICKER_DIST_ID,
      tempFileKey,
      snapshotDate: TEST_DATE,
      mapping,
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

    const zeroRow = rows.find((r) => r.vpn_normalized === `TSTZERO${suffix}`);
    const negRow  = rows.find((r) => r.vpn_normalized === `TSTNEG${suffix}`);
    const posRow  = rows.find((r) => r.vpn_normalized === `TSTPOS${suffix}`);

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
      `/api/comparison?brand=SAMSUNG&search=TSTZERO${suffix}`,
    );
    expect(compRes.ok()).toBeTruthy();

    type DistEntry = { distributorId: number; soh: number | null };
    type ProductRow = { vpnNormalized: string; distributors: DistEntry[] };
    const compBody = await compRes.json() as { rows: ProductRow[] };

    const product = compBody.rows.find(
      (p) => p.vpnNormalized === `TSTZERO${suffix}`,
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
    const zeroRow = afterSecond.find((r) => r.vpn_normalized === `TSTZERO${suffix}`);
    const negRow  = afterSecond.find((r) => r.vpn_normalized === `TSTNEG${suffix}`);
    expect(zeroRow!.soh).toBe(0);
    expect(negRow!.soh).toBe(-5);
  } finally {
    await dbCleanup(suffix);
    await ctx.dispose();
  }
});

// ── Test 5 ───────────────────────────────────────────────────────────────────
// Two uploads with different VPN formats (hyphen vs space) normalise to a single
// product record; the second upload's price replaces the first.
// ─────────────────────────────────────────────────────────────────────────────

test("hyphen and space VPN variants normalise to one product — latest price wins", async () => {
  const suffix = uid();
  // Both "TST-NORM-${suffix}" and "TST NORM ${suffix}" strip to "TSTNORM${suffix}"
  const csvHyphen = [
    "StockCode,Vendor,DealerEx,StockAvailable,StockDescription",
    `TST-NORM-${suffix},SAMSUNG,138.00,50,Test Norm Hyphen ${suffix}`,
  ].join("\n");
  const csvSpace = [
    "StockCode,Vendor,DealerEx,StockAvailable,StockDescription",
    `TST NORM ${suffix},SAMSUNG,124.00,40,Test Norm Space ${suffix}`,
  ].join("\n");

  const normalizedVpn = `TSTNORM${suffix}`;
  const ctx = await getAdminApi();

  async function cleanup() {
    await withDb(async (client) => {
      await client.query(
        `DELETE FROM stock_snapshots
         WHERE product_id IN (SELECT id FROM products WHERE vpn_normalized = $1)`,
        [normalizedVpn],
      );
      await client.query(`DELETE FROM products WHERE vpn_normalized = $1`, [normalizedVpn]);
    });
  }

  try {
    // First upload — hyphenated VPN, price 138.
    const key1 = await parseCsv(ctx, csvHyphen, `dicker-norm-hyph-${suffix}.csv`);
    const { rowCountMatched: matched1 } = await commitUpload(ctx, key1);
    expect(matched1).toBe(1);

    // Second upload — spaced VPN, price 124. Must merge into existing product.
    const key2 = await parseCsv(ctx, csvSpace, `dicker-norm-space-${suffix}.csv`);
    const { rowCountMatched: matched2 } = await commitUpload(ctx, key2);
    expect(matched2).toBe(1);

    // DB: exactly one product with the normalised VPN.
    const { rows: products } = await withDb((client) =>
      client.query<{ id: number; vpn_normalized: string }>(
        `SELECT id, vpn_normalized FROM products WHERE vpn_normalized = $1`,
        [normalizedVpn],
      ),
    );
    expect(products).toHaveLength(1);

    // DB: that single product must have the latest price (124.00) from the second upload.
    const { rows: snaps } = await withDb((client) =>
      client.query<{ sell_price: string }>(
        `SELECT DISTINCT ON (product_id, distributor_id) sell_price
         FROM stock_snapshots
         WHERE product_id = $1 AND distributor_id = $2
         ORDER BY product_id, distributor_id, snapshot_date DESC, id DESC`,
        [products[0].id, DICKER_DIST_ID],
      ),
    );
    expect(snaps).toHaveLength(1);
    expect(parseFloat(snaps[0].sell_price)).toBeCloseTo(124.0);
  } finally {
    await cleanup();
    await ctx.dispose();
  }
});

// ── Test 6 ───────────────────────────────────────────────────────────────────
// U-POE+ and U-POE++ must remain two separate products after commit.
// The + character is preserved in normalisation so these keys never collide.
// ─────────────────────────────────────────────────────────────────────────────

test("U-POE+ and U-POE++ committed together remain two separate products", async () => {
  const suffix = uid();
  // TST-POE+${suffix}  → TSTPOE+${suffix}
  // TST-POE++${suffix} → TSTPOE++${suffix}
  const csv = [
    "StockCode,Vendor,DealerEx,StockAvailable,StockDescription",
    `TST-POE+${suffix},NETGEAR,50.00,10,Test POE Plus ${suffix}`,
    `TST-POE++${suffix},NETGEAR,80.00,5,Test POE PlusPlus ${suffix}`,
  ].join("\n");

  const vpnPlus     = `TSTPOE+${suffix}`;
  const vpnPlusPlus = `TSTPOE++${suffix}`;
  const ctx = await getAdminApi();

  async function cleanup() {
    await withDb(async (client) => {
      const vpns = [vpnPlus, vpnPlusPlus];
      await client.query(
        `DELETE FROM stock_snapshots
         WHERE product_id IN (SELECT id FROM products WHERE vpn_normalized = ANY($1))`,
        [vpns],
      );
      await client.query(`DELETE FROM products WHERE vpn_normalized = ANY($1)`, [vpns]);
    });
  }

  try {
    const key = await parseCsv(ctx, csv, `dicker-poe-${suffix}.csv`);
    const { rowCountMatched } = await commitUpload(ctx, key);
    expect(rowCountMatched).toBe(2);

    // DB: must have two distinct product records — one per + count.
    const { rows } = await withDb((client) =>
      client.query<{ vpn_normalized: string }>(
        `SELECT vpn_normalized FROM products
         WHERE vpn_normalized = ANY($1)`,
        [[vpnPlus, vpnPlusPlus]],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.vpn_normalized === vpnPlus)).toBe(true);
    expect(rows.some((r) => r.vpn_normalized === vpnPlusPlus)).toBe(true);
  } finally {
    await cleanup();
    await ctx.dispose();
  }
});
