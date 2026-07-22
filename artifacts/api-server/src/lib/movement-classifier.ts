export interface SnapshotPoint {
  soh: number | null;
  soo: number | null;
}

export interface ClassifierResult {
  estUnitsSold: number;
}

/**
 * Competitor market intelligence: estimate units sold by a competing distributor
 * over a window so Dicker PMs can gauge whether to range the stock.
 *
 * Walk all consecutive snapshot pairs and accumulate estimated units sold:
 *   soh_d = curr.soh - prev.soh
 *   soo_d = (curr.soo ?? 0) - (prev.soo ?? 0)
 *
 *   soh_d < 0                        → pure SOH decline: +(-soh_d)
 *   soh_d > 0 AND soo_d < 0         → delivery with masked sales:
 *                                        +max(0, -soo_d - soh_d)
 *
 * Pairs where either soh is null are skipped.
 * Result is a lower-bound (estimates are minimums).
 */
export function classifyMovement(snapshots: SnapshotPoint[]): ClassifierResult {
  let estUnitsSold = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;

    const prevSoh = prev.soh;
    const currSoh = curr.soh;
    if (prevSoh == null || currSoh == null) continue;

    const soh_d = currSoh - prevSoh;
    const soo_d = (curr.soo ?? 0) - (prev.soo ?? 0);

    if (soh_d < 0) {
      estUnitsSold += -soh_d;
    } else if (soh_d > 0 && soo_d < 0) {
      estUnitsSold += Math.max(0, -soo_d - soh_d);
    }
  }

  return { estUnitsSold };
}
