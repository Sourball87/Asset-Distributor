export interface SnapshotPoint {
  soh: number | null;
  soo: number | null;
}

export interface ClassifierResult {
  estUnitsOut: number;
  unitsIn: number;
  reorderFlag: boolean;
}

/**
 * Walk all consecutive snapshot pairs and classify each interval.
 *
 * soh_d = curr.soh - prev.soh
 * soo_d = (curr.soo ?? 0) - (prev.soo ?? 0)
 *
 *   soh_d < 0                    → outgoing:  estUnitsOut += -soh_d
 *   soh_d > 0 AND soo_d < 0     → delivery with masked sales:
 *                                    estUnitsOut += max(0, -soo_d - soh_d)
 *                                    unitsIn     += soh_d
 *   soh_d > 0 AND soo_d >= 0    → restock: unitsIn += soh_d
 *   soo_d > 0 (independent)     → reorderFlag = true
 *
 * In soh_only mode (soo always null/0) this degrades to a pure SOH-decline
 * floor — estUnitsOut is a lower bound on actual sales.
 *
 * Pairs where either soh value is null are skipped.
 */
export function classifyMovement(snapshots: SnapshotPoint[]): ClassifierResult {
  let estUnitsOut = 0;
  let unitsIn = 0;
  let reorderFlag = false;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;

    const prevSoh = prev.soh;
    const currSoh = curr.soh;
    if (prevSoh == null || currSoh == null) continue;

    const prevSoo = prev.soo ?? 0;
    const currSoo = curr.soo ?? 0;

    const soh_d = currSoh - prevSoh;
    const soo_d = currSoo - prevSoo;

    if (soh_d < 0) {
      estUnitsOut += -soh_d;
    } else if (soh_d > 0 && soo_d < 0) {
      estUnitsOut += Math.max(0, -soo_d - soh_d);
      unitsIn += soh_d;
    } else if (soh_d > 0 && soo_d >= 0) {
      unitsIn += soh_d;
    }

    if (soo_d > 0) {
      reorderFlag = true;
    }
  }

  return { estUnitsOut, unitsIn, reorderFlag };
}
