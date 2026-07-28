/**
 * Integration tests for commitRowsBatched — the core upload commit pipeline.
 *
 * These tests hit the real development database. All test data uses a unique
 * brand ("VITEST_TESTBRAND_UNIQUE_99") and distributor name so they never
 * collide with production rows. TEST_DATE is in 2099 for the same reason.
 *
 * Scenarios covered:
 *   A. Empty upload safety — existing committed upload + new zero-match upload
 *      → existing stays committed with its rows; new returns 0 (no data loss).
 *   B. Re-upload same slot — prior upload flips to superseded; new upload's
 *      snapshots are the only live rows for that distributor+date.
 *   C. New upload not self-superseded — the WHERE status='committed' filter
 *      means the new upload (still 'parsing') is never touched by the UPDATE.
 *   D. Anchor fallback — a committed upload with zero snapshot rows is excluded
 *      by the EXISTS filter used in the comparison CTE.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  db,
  brandsTable,
  distributorsTable,
  uploadsTable,
  productsTable,
  stockSnapshotsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { commitRowsBatched } from "../routes/uploads";

// ─── Unique test markers ──────────────────────────────────────────────────────
const TEST_BRAND    = "VITEST_TESTBRAND_UNIQUE_99";
const TEST_DIST     = "VITEST_TEST_DISTRIBUTOR_UNIQUE_99";
const TEST_DATE     = "2099-06-15";  // far-future — never collides with real data
const TEST_DATE_2   = "2099-06-14";  // one day earlier, for anchor-fallback test
const TEST_VPN      = "VITEST-VPN-001-UNIQUE";

// Shared state set up in beforeAll
let testDistId: number;

// A minimal brand map for testBrand only (bypasses the DB buildBrandMap call)
const testBrandMap = new Map<string, string>([
  [TEST_BRAND,                         TEST_BRAND],
  [TEST_BRAND.toUpperCase(),           TEST_BRAND],
]);

// Rows that will match the test brand
const matchedRows = [
  { vpn: TEST_VPN, brand: TEST_BRAND, price: "10.00", soh: "5", desc: "Test product" },
];

// Rows whose brand is NOT in the map — will match nothing
const noMatchRows = [
  { vpn: "VITEST-VPN-NOMATCH-99", brand: "UNKNOWN_BRAND_XYZZY_99", price: "5.00", soh: "1", desc: "no match" },
];

const mapping: Record<string, string | null> = {
  vpn:         "vpn",
  brand:       "brand",
  sell_price:  "price",
  soh:         "soh",
  description: "desc",
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Ensure the test brand exists
  await db
    .insert(brandsTable)
    .values({ canonicalName: TEST_BRAND, aliases: [], referenceOnly: false })
    .onConflictDoNothing();

  // Ensure the test distributor exists and capture its ID
  const existing = await db
    .select({ id: distributorsTable.id })
    .from(distributorsTable)
    .where(eq(distributorsTable.name, TEST_DIST));

  if (existing.length > 0) {
    testDistId = existing[0]!.id;
  } else {
    const [dist] = await db
      .insert(distributorsTable)
      .values({ name: TEST_DIST, isBaseline: false, stalenessThresholdDays: 7 })
      .returning();
    testDistId = dist!.id;
  }
});

// Wipe all test artifacts between tests for isolation
beforeEach(async () => {
  await db
    .delete(stockSnapshotsTable)
    .where(eq(stockSnapshotsTable.distributorId, testDistId));
  await db
    .delete(uploadsTable)
    .where(eq(uploadsTable.distributorId, testDistId));
  await db
    .delete(productsTable)
    .where(eq(productsTable.brand, TEST_BRAND));
});

// Final cleanup — FK order: snapshots → uploads → products → distributor → brand
afterAll(async () => {
  await db
    .delete(stockSnapshotsTable)
    .where(eq(stockSnapshotsTable.distributorId, testDistId));
  await db
    .delete(uploadsTable)
    .where(eq(uploadsTable.distributorId, testDistId));
  await db
    .delete(productsTable)
    .where(eq(productsTable.brand, TEST_BRAND));
  await db
    .delete(distributorsTable)
    .where(eq(distributorsTable.name, TEST_DIST));
  await db
    .delete(brandsTable)
    .where(eq(brandsTable.canonicalName, TEST_BRAND));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a committed upload that already has one snapshot row in the DB. */
async function seedCommittedUpload(date: string): Promise<number> {
  const [upload] = await db
    .insert(uploadsTable)
    .values({
      distributorId: testDistId,
      filename: "seed.csv",
      snapshotDate: date,
      rowCountTotal: 1,
      rowCountMatched: 1,
      status: "committed",
    })
    .returning();
  const uploadId = upload!.id;

  // Ensure the product exists
  await db
    .insert(productsTable)
    .values({ vpnNormalized: TEST_VPN, vpnDisplay: TEST_VPN, brand: TEST_BRAND, description: "Seed product" })
    .onConflictDoNothing();

  const [product] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.vpnNormalized, TEST_VPN));

  await db.insert(stockSnapshotsTable).values({
    uploadId,
    distributorId: testDistId,
    productId: product!.id,
    snapshotDate: date,
    sellPrice: "9.99",
    soh: 10,
  });

  return uploadId;
}

/** Create a 'parsing' upload record (mimics what the commit endpoint does). */
async function seedParsingUpload(date: string): Promise<number> {
  const [upload] = await db
    .insert(uploadsTable)
    .values({
      distributorId: testDistId,
      filename: "new.csv",
      snapshotDate: date,
      rowCountTotal: 1,
      rowCountMatched: 0,
      status: "parsing",
    })
    .returning();
  return upload!.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("commitRowsBatched — upload hardening invariants", () => {

  // ── Scenario A ──────────────────────────────────────────────────────────────
  it("A: zero-match upload leaves existing committed upload and its rows fully intact", async () => {
    const priorUploadId = await seedCommittedUpload(TEST_DATE);
    const newUploadId   = await seedParsingUpload(TEST_DATE);

    // noMatchRows → parsed.length === 0 → early return before transaction
    const result = await commitRowsBatched(
      noMatchRows,
      mapping,
      newUploadId,
      testDistId,
      TEST_DATE,
      testBrandMap,
    );

    expect(result).toBe(0);

    // Prior upload MUST still be 'committed'
    const [prior] = await db
      .select({ status: uploadsTable.status })
      .from(uploadsTable)
      .where(eq(uploadsTable.id, priorUploadId));
    expect(prior?.status).toBe("committed");

    // Prior snapshot rows MUST still exist
    const priorSnapshots = await db
      .select({ id: stockSnapshotsTable.id })
      .from(stockSnapshotsTable)
      .where(eq(stockSnapshotsTable.uploadId, priorUploadId));
    expect(priorSnapshots.length).toBe(1);

    // New upload MUST NOT have any snapshot rows
    const newSnapshots = await db
      .select({ id: stockSnapshotsTable.id })
      .from(stockSnapshotsTable)
      .where(eq(stockSnapshotsTable.uploadId, newUploadId));
    expect(newSnapshots.length).toBe(0);
  });

  // ── Scenario B ──────────────────────────────────────────────────────────────
  it("B: re-upload same distributor+date flips prior upload to superseded and replaces rows", async () => {
    // First commit: creates upload A + its snapshots
    const uploadAId = await seedParsingUpload(TEST_DATE);
    const resultA = await commitRowsBatched(
      matchedRows,
      mapping,
      uploadAId,
      testDistId,
      TEST_DATE,
      testBrandMap,
    );
    expect(resultA).toBe(1);

    // Simulate the endpoint marking upload A as committed
    await db
      .update(uploadsTable)
      .set({ status: "committed", rowCountMatched: 1 })
      .where(eq(uploadsTable.id, uploadAId));

    // Second commit: creates upload B for the same distributor+date
    const uploadBId = await seedParsingUpload(TEST_DATE);
    const resultB = await commitRowsBatched(
      matchedRows,
      mapping,
      uploadBId,
      testDistId,
      TEST_DATE,
      testBrandMap,
    );
    expect(resultB).toBe(1);

    // Upload A MUST be superseded
    const [uploadA] = await db
      .select({ status: uploadsTable.status })
      .from(uploadsTable)
      .where(eq(uploadsTable.id, uploadAId));
    expect(uploadA?.status).toBe("superseded");

    // Upload A MUST have no snapshot rows (deleted by the replace-semantics DELETE)
    const uploadASnaps = await db
      .select({ id: stockSnapshotsTable.id })
      .from(stockSnapshotsTable)
      .where(eq(stockSnapshotsTable.uploadId, uploadAId));
    expect(uploadASnaps.length).toBe(0);

    // Upload B MUST have its snapshot rows
    const uploadBSnaps = await db
      .select({ id: stockSnapshotsTable.id })
      .from(stockSnapshotsTable)
      .where(eq(stockSnapshotsTable.uploadId, uploadBId));
    expect(uploadBSnaps.length).toBe(1);
  });

  // ── Scenario C ──────────────────────────────────────────────────────────────
  it("C: the new upload (status=parsing) is NOT marked superseded by the UPDATE", async () => {
    // Upload starts as 'parsing' — the superseded UPDATE filters on status='committed',
    // so it must never touch a 'parsing' upload, even for the same distributor+date.
    const newUploadId = await seedParsingUpload(TEST_DATE);

    await commitRowsBatched(
      matchedRows,
      mapping,
      newUploadId,
      testDistId,
      TEST_DATE,
      testBrandMap,
    );

    // The new upload must remain 'parsing' after the commit pipeline
    // (the endpoint, not commitRowsBatched, sets it to 'committed')
    const [newUpload] = await db
      .select({ status: uploadsTable.status })
      .from(uploadsTable)
      .where(eq(uploadsTable.id, newUploadId));
    expect(newUpload?.status).toBe("parsing");
  });

  // ── Scenario D ──────────────────────────────────────────────────────────────
  it("D: EXISTS anchor filter excludes committed uploads that have zero snapshot rows", async () => {
    // Upload for TEST_DATE (newer) — committed but with NO rows
    const emptyUploadId = await seedParsingUpload(TEST_DATE);
    await db
      .update(uploadsTable)
      .set({ status: "committed" })
      .where(eq(uploadsTable.id, emptyUploadId));
    // Do NOT insert any stock_snapshots for emptyUploadId

    // Upload for TEST_DATE_2 (older) — committed WITH rows
    const priorUploadId = await seedCommittedUpload(TEST_DATE_2);
    void priorUploadId; // only need it in the DB

    // Run the same EXISTS-filtered query the comparison CTE uses
    const rows = await db.execute(sql`
      SELECT
        MAX(u.snapshot_date) AS anchor_date
      FROM uploads u
      WHERE u.distributor_id = ${testDistId}
        AND u.status = 'committed'
        AND EXISTS (SELECT 1 FROM stock_snapshots ss WHERE ss.upload_id = u.id)
    `);

    const anchorDate = (rows.rows[0] as { anchor_date: string } | undefined)?.anchor_date;

    // Must fall back to TEST_DATE_2 (the older date that has rows)
    // NOT TEST_DATE (the newer date with no rows)
    expect(anchorDate).toBe(TEST_DATE_2);
  });

});
