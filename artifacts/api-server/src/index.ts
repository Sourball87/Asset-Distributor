import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { migrateVpnNormalization } from "./lib/migrate-vpn-normalization";
import { migrateSuperseededBackfill } from "./lib/migrate-superseded-backfill";
import { db, marketPriceCacheTable } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedIfEmpty().catch((err) => {
  logger.error({ err }, "Seed failed");
});

// Run the one-time VPN normalization migration before accepting traffic.
// Awaiting here blocks app.listen so no upload commits can race the migration.
// The function is production-only and idempotent — it exits in ~1ms when the
// DB is already clean.
try {
  await migrateVpnNormalization();
} catch (err) {
  logger.error({ err }, "VPN normalization migration failed — server starting anyway");
}

try {
  await migrateSuperseededBackfill();
} catch (err) {
  logger.error({ err }, "Superseded backfill migration failed — server starting anyway");
}

// One-shot cache purge: set CLEAR_MARKET_PRICE_CACHE_ON_START=1 in production
// env vars before a deploy to flush stale LLM results after pattern/prompt fixes.
// Idempotent — safe to leave set; subsequent startups just delete 0 rows.
if (process.env["CLEAR_MARKET_PRICE_CACHE_ON_START"] === "1") {
  try {
    const deleted = await db.delete(marketPriceCacheTable);
    logger.info({ deletedRows: (deleted as unknown as { rowCount?: number }).rowCount ?? "?" },
      "CLEAR_MARKET_PRICE_CACHE_ON_START: flushed market-price cache");
  } catch (err) {
    logger.error({ err }, "CLEAR_MARKET_PRICE_CACHE_ON_START: cache flush failed — starting anyway");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
