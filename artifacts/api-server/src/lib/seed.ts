import bcrypt from "bcryptjs";
import { db, usersTable, distributorsTable, brandsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const SEED_DISTRIBUTORS = [
  { name: "Dicker Data",    isBaseline: true,  stalenessThresholdDays: 1 },
  { name: "Ingram Micro",   isBaseline: false, stalenessThresholdDays: 1 },
  { name: "Leader Systems", isBaseline: false, stalenessThresholdDays: 1 },
  { name: "Synnex",         isBaseline: false, stalenessThresholdDays: 1 },
  { name: "MMT",            isBaseline: false, stalenessThresholdDays: 1 },
  { name: "Bluechip",       isBaseline: false, stalenessThresholdDays: 1 },
];

const SEED_BRANDS = [
  { canonicalName: "SAMSUNG",     aliases: ["Samsung", "SAMSUNG ELECTRONICS"] },
  { canonicalName: "DELL",        aliases: ["Dell", "DELL TECHNOLOGIES", "Dell Technologies"] },
  { canonicalName: "APC",         aliases: ["Apc", "APC BY SCHNEIDER", "APC by Schneider Electric"] },
  { canonicalName: "TP LINK",     aliases: ["Tp Link", "TP-LINK", "Tp-Link", "TP Link"] },
  { canonicalName: "NETGEAR",     aliases: ["Netgear", "NETGEAR - Commercial"] },
  { canonicalName: "SEAGATE",     aliases: ["Seagate", "SEAGATE TECHNOLOGY"] },
  { canonicalName: "ASUS",        aliases: ["Asus", "ASUS System", "ASUS - Commercial"] },
  { canonicalName: "LENOVO",      aliases: ["Lenovo", "LENOVO GROUP"] },
  { canonicalName: "JABRA",       aliases: ["Jabra", "GN AUDIO"] },
  { canonicalName: "LOGITECH",    aliases: ["Logitech", "LOGITECH INTERNATIONAL"] },
  { canonicalName: "PHILIPS",     aliases: ["Philips", "PHILIPS ELECTRONICS"] },
  { canonicalName: "MICROSOFT",   aliases: ["Microsoft", "MICROSOFT CORPORATION"] },
  { canonicalName: "QNAP",        aliases: ["Qnap", "QNAP SYSTEMS"] },
  { canonicalName: "POWERSHIELD", aliases: ["Powershield", "POWER SHIELD"] },
  { canonicalName: "KENSINGTON",  aliases: ["Kensington", "KENSINGTON COMPUTER PRODUCTS"] },
  { canonicalName: "LG",          aliases: ["Lg", "LG ELECTRONICS"] },
  { canonicalName: "UBIQUITI",    aliases: ["Ubiquiti", "Ubiquiti Networks", "UBIQUITI NETWORKS", "Ubiquiti Inc"] },
];

export async function seedIfEmpty(): Promise<void> {
  let seeded = false;

  // Admin user — skip if already exists
  const [existingUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (!existingUser) {
    const passwordHash = await bcrypt.hash("admin", 10);
    await db.insert(usersTable).values({
      email: "admin@dickerdata.com.au",
      name: "Admin",
      passwordHash,
      role: "admin",
    });
    seeded = true;
    logger.info("Seed: admin user created");
  }

  // Distributors — insert any that are missing (by name, idempotent)
  for (const dist of SEED_DISTRIBUTORS) {
    await db
      .insert(distributorsTable)
      .values(dist)
      .onConflictDoNothing({ target: distributorsTable.name });
  }

  // Brands — insert any that are missing (by canonical name, idempotent)
  for (const brand of SEED_BRANDS) {
    await db
      .insert(brandsTable)
      .values(brand)
      .onConflictDoNothing({ target: brandsTable.canonicalName });
  }

  if (seeded) {
    logger.info("Seed complete");
  }
}
