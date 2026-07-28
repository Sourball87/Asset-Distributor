import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { migrateVpnNormalization } from "./lib/migrate-vpn-normalization";
import { migrateSuperseededBackfill } from "./lib/migrate-superseded-backfill";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
