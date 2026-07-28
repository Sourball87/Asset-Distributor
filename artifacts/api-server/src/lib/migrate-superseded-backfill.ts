import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-time production data migration:
 *  1. Backfill uploads 48, 67, and 71 to status='superseded'.
 *     These uploads were committed but had their snapshot rows replaced by later
 *     uploads for the same distributor+date before superseded tracking was added.
 *  2. TRUNCATE market_price_cache.
 *     Upload 56 (a bad NZ file) was live while market-price lookups ran; cached
 *     JSON for AU products may contain NZ-context prices that cannot be detected
 *     by an integrity check. A full clear is safer than a targeted delete.
 *
 * Production-only — exits immediately in non-production environments.
 * Idempotent — the backfill UPDATE is a no-op once the rows are already
 * superseded; the cache TRUNCATE is safe to run multiple times.
 */
export async function migrateSuperseededBackfill(): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    logger.info("migrateSuperseededBackfill: non-production environment — skipping");
    return;
  }

  const client = await pool.connect();
  try {
    // Quick-check: are any of the target uploads still 'committed'?
    // If none are, both sub-tasks have already run — skip everything.
    const { rows: checkRows } = await client.query<{ needs_backfill: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM uploads WHERE id IN (48, 67, 71) AND status = 'committed'
      ) AS needs_backfill
    `);

    if (!checkRows[0]?.needs_backfill) {
      logger.info("migrateSuperseededBackfill: backfill already clean — skipping");
      // Cache truncate is still safe to call on every startup; skip it here to
      // avoid clearing legitimate cache entries on subsequent restarts.
      return;
    }

    logger.info("migrateSuperseededBackfill: backfilling uploads 48, 67, 71 + truncating market_price_cache");

    await client.query("BEGIN");

    const { rowCount: backfilled } = await client.query(`
      UPDATE uploads SET status = 'superseded'
      WHERE id IN (48, 67, 71) AND status = 'committed'
    `);
    logger.info({ backfilled }, "migrateSuperseededBackfill: backfill done");

    await client.query("TRUNCATE TABLE market_price_cache");
    logger.info("migrateSuperseededBackfill: market_price_cache truncated");

    await client.query("COMMIT");
    logger.info("migrateSuperseededBackfill: committed");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
