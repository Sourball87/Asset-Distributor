/**
 * VPN (Vendor Part Number) normalization utilities.
 *
 * Normalization rule: trim whitespace, uppercase, strip every character that is
 * not A–Z, 0–9, or +.
 *
 * + is preserved deliberately — it is semantically significant in part-number
 * suffixes such as PoE+, PoE++, and NBD+ service tiers.  Merging those into
 * the same key as their non-plus siblings would create false matches.
 *
 * To change the rule, edit normalizeVpn only — it is used everywhere.
 */
export function normalizeVpn(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9+]/g, "");
}
