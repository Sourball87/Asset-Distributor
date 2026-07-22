/**
 * shouldUpdateDescription — pure function extracted from commitRowsBatched.
 *
 * Returns true when the incoming description is at least 30% longer than the
 * stored one, meaning the new feed is carrying richer data and should win.
 *
 * Rationale: distributors vary in description quality. A later import with a
 * longer description is almost always more spec-rich; adopting it progressively
 * improves the catalogue without requiring a full re-import.
 *
 * NULL / empty stored description → always replaced (0 × 1.3 = 0, any non-empty wins).
 */
export function shouldUpdateDescription(stored: string | null | undefined, incoming: string): boolean {
  const storedLen = stored?.length ?? 0;
  return incoming.length >= storedLen * 1.3;
}
