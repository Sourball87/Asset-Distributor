import { db, brandsTable } from "@workspace/db";

/**
 * Normalize a brand string for matching (case+whitespace insensitive).
 */
function normalizeBrandKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Build alias → canonical map from DB.
 * Call once per request (or cache as needed).
 */
export async function buildBrandMap(): Promise<Map<string, string>> {
  const brands = await db.select().from(brandsTable);
  const map = new Map<string, string>();
  for (const brand of brands) {
    map.set(normalizeBrandKey(brand.canonicalName), brand.canonicalName);
    for (const alias of brand.aliases) {
      map.set(normalizeBrandKey(alias), brand.canonicalName);
    }
  }
  return map;
}

/**
 * Resolve a raw brand string to the canonical brand name.
 * Returns null if not in the tracked list.
 */
export function resolveCanonicalBrand(
  raw: string,
  brandMap: Map<string, string>,
): string | null {
  return brandMap.get(normalizeBrandKey(raw)) ?? null;
}
