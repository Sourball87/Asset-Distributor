/**
 * VPN (Vendor Part Number) normalization utilities.
 *
 * Normalization rule: trim whitespace, uppercase, collapse internal multiple spaces.
 * Dashes are preserved — they can be significant in part numbers.
 * To change the rule, edit normalizeVpn only — it is used everywhere.
 */
export function normalizeVpn(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}
