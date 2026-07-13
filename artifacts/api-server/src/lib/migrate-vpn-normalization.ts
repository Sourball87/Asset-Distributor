import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-time production data migration: merge products whose vpn_normalized
 * values are equivalent under the new normalization rule (strip everything
 * except [A-Z0-9+]) and clean up stale snapshot rows from superseded uploads.
 *
 * Safe to run on every startup — the quick-check query exits early if there
 * is nothing to do (i.e. every vpn_normalized is already fully stripped).
 */
export async function migrateVpnNormalization(): Promise<void> {
  const client = await pool.connect();
  try {
    // Quick-check: are there any products whose vpn_normalized still contains
    // characters outside [A-Z0-9+]?
    const { rows: checkRows } = await client.query<{ needs_migration: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM products
        WHERE vpn_normalized != UPPER(REGEXP_REPLACE(vpn_normalized, '[^A-Za-z0-9+]', '', 'g'))
           OR vpn_normalized != UPPER(vpn_normalized)
        LIMIT 1
      ) AS needs_migration
    `);

    if (!checkRows[0]?.needs_migration) {
      logger.info("migrateVpnNormalization: already clean — skipping");
      return;
    }

    logger.info("migrateVpnNormalization: starting production VPN normalization migration");

    await client.query("BEGIN");

    // ── Step 1: merge duplicate products ──────────────────────────────────
    // Build merge groups in a temp table (winner = lowest ID per merge_key + brand)
    await client.query(`
      CREATE TEMP TABLE t_vpn_merge AS
      WITH keyed AS (
        SELECT id, brand,
               UPPER(REGEXP_REPLACE(vpn_normalized, '[^A-Za-z0-9+]', '', 'g')) AS merge_key
        FROM products
      ),
      grp AS (
        SELECT merge_key, brand,
               MIN(id) AS winner_id,
               ARRAY_AGG(id ORDER BY id) AS all_ids
        FROM keyed
        GROUP BY merge_key, brand
        HAVING COUNT(*) > 1
      )
      SELECT merge_key, brand, winner_id, UNNEST(all_ids) AS product_id
      FROM grp
    `);

    // Count what we're about to do for logging
    const { rows: countRows } = await client.query<{
      merge_groups: string;
      losers: string;
    }>(`
      SELECT
        COUNT(DISTINCT merge_key)                               AS merge_groups,
        COUNT(*) FILTER (WHERE product_id != winner_id)        AS losers
      FROM t_vpn_merge
    `);
    const mergeGroups = Number(countRows[0]?.merge_groups ?? 0);
    const losers      = Number(countRows[0]?.losers ?? 0);
    logger.info({ mergeGroups, losers }, "migrateVpnNormalization: merge groups identified");

    // Repoint snapshots from loser products to winner
    const { rowCount: repointedRows } = await client.query(`
      UPDATE stock_snapshots
      SET product_id = mg.winner_id
      FROM t_vpn_merge mg
      WHERE stock_snapshots.product_id = mg.product_id
        AND mg.product_id != mg.winner_id
    `);
    logger.info({ repointedRows }, "migrateVpnNormalization: snapshots repointed");

    // Remove duplicate snapshot rows created by the repoint
    // (same product_id + distributor_id + snapshot_date: keep highest id)
    const { rowCount: dedupedRows } = await client.query(`
      DELETE FROM stock_snapshots
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY product_id, distributor_id, snapshot_date
                   ORDER BY id DESC
                 ) AS rn
          FROM stock_snapshots
        ) ranked
        WHERE rn > 1
      )
    `);
    logger.info({ dedupedRows }, "migrateVpnNormalization: duplicate snapshot rows removed");

    // Delete loser products
    const { rowCount: deletedProducts } = await client.query(`
      DELETE FROM products
      WHERE id IN (
        SELECT product_id FROM t_vpn_merge WHERE product_id != winner_id
      )
    `);
    logger.info({ deletedProducts }, "migrateVpnNormalization: loser products deleted");

    // ── Step 2: re-normalize all remaining vpn_normalized values ──────────
    const { rowCount: renormalizedProducts } = await client.query(`
      UPDATE products
      SET vpn_normalized = UPPER(REGEXP_REPLACE(vpn_normalized, '[^A-Za-z0-9+]', '', 'g'))
      WHERE vpn_normalized != UPPER(REGEXP_REPLACE(vpn_normalized, '[^A-Za-z0-9+]', '', 'g'))
         OR vpn_normalized != UPPER(vpn_normalized)
    `);
    logger.info({ renormalizedProducts }, "migrateVpnNormalization: products re-normalized");

    // ── Step 3: stale snapshot cleanup ────────────────────────────────────
    // Delete snapshot rows from superseded uploads (same distributor+date, not latest upload)
    await client.query(`
      CREATE TEMP TABLE t_latest_upload AS
      SELECT distributor_id, snapshot_date, MAX(id) AS latest_upload_id
      FROM uploads
      WHERE status != 'invalid_mapping'
      GROUP BY distributor_id, snapshot_date
    `);

    const { rowCount: staleSnapshots } = await client.query(`
      DELETE FROM stock_snapshots ss
      USING uploads u
      JOIN t_latest_upload lp
        ON lp.distributor_id = u.distributor_id
       AND lp.snapshot_date  = u.snapshot_date
      WHERE ss.upload_id = u.id
        AND u.id != lp.latest_upload_id
    `);
    logger.info({ staleSnapshots }, "migrateVpnNormalization: stale snapshot rows deleted");

    await client.query("COMMIT");

    // ── Post-commit sanity check ───────────────────────────────────────────
    const { rows: sanityRows } = await client.query<{
      dirty_products: string;
      orphan_snapshots: string;
      multi_upload_pairs: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM products
          WHERE vpn_normalized != UPPER(REGEXP_REPLACE(vpn_normalized, '[^A-Za-z0-9+]', '', 'g'))
             OR vpn_normalized != UPPER(vpn_normalized)
        ) AS dirty_products,
        (SELECT COUNT(*) FROM stock_snapshots ss
          WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = ss.product_id)
        ) AS orphan_snapshots,
        (SELECT COUNT(*) FROM (
          SELECT u.distributor_id, u.snapshot_date
          FROM stock_snapshots ss2
          JOIN uploads u ON u.id = ss2.upload_id
          GROUP BY u.distributor_id, u.snapshot_date
          HAVING COUNT(DISTINCT ss2.upload_id) > 1
        ) bad
        ) AS multi_upload_pairs
    `);

    logger.info(
      {
        dirtyProducts:    Number(sanityRows[0]?.dirty_products    ?? -1),
        orphanSnapshots:  Number(sanityRows[0]?.orphan_snapshots  ?? -1),
        multiUploadPairs: Number(sanityRows[0]?.multi_upload_pairs ?? -1),
      },
      "migrateVpnNormalization: post-commit sanity",
    );

    logger.info("migrateVpnNormalization: migration complete");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err }, "migrateVpnNormalization: FAILED — rolled back");
    throw err;
  } finally {
    client.release();
  }
}
