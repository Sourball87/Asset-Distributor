import bcrypt from "bcryptjs";
import { db, usersTable, distributorsTable, brandsTable } from "@workspace/db";
import { logger } from "./logger";

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
];

export async function seedIfEmpty(): Promise<void> {
  const [existingUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (existingUser) {
    return;
  }

  logger.info("Empty database detected — running initial seed");

  const passwordHash = await bcrypt.hash("admin", 10);
  await db.insert(usersTable).values({
    email: "admin@dickerdata.com.au",
    name: "Admin",
    passwordHash,
    role: "admin",
  });

  const [existingDist] = await db.select({ id: distributorsTable.id }).from(distributorsTable).limit(1);
  if (!existingDist) {
    await db.insert(distributorsTable).values({
      name: "Dicker Data",
      isBaseline: true,
      stalenessThresholdDays: 1,
    });
  }

  const [existingBrand] = await db.select({ id: brandsTable.id }).from(brandsTable).limit(1);
  if (!existingBrand) {
    await db.insert(brandsTable).values(SEED_BRANDS);
  }

  logger.info("Seed complete — admin@dickerdata.com.au created");
}
