import { describe, it, expect } from "vitest";
import { classifyMovement } from "./movement-classifier";

// Helper: compute weekly sell-through from snapshots (mirrors route logic)
function weeklyRate(
  snapshots: Array<{ soh: number | null; soo?: number | null; date: string }>,
): number | null {
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const daysCovered = Math.round(
    (new Date(sorted[sorted.length - 1]!.date).getTime() - new Date(sorted[0]!.date).getTime()) / 86_400_000,
  );
  if (sorted.length < 2 || daysCovered < 7) return null;
  const { estUnitsSold } = classifyMovement(sorted.map((s) => ({ soh: s.soh, soo: s.soo ?? null })));
  return Math.round((estUnitsSold / daysCovered) * 7 * 10) / 10;
}

describe("classifyMovement — estUnitsSold", () => {
  it("pure decline: SOH falls with no SOO change", () => {
    const result = classifyMovement([
      { soh: 100, soo: 0 },
      { soh: 80,  soo: 0 },
      { soh: 50,  soo: 0 },
    ]);
    expect(result.estUnitsSold).toBe(50);
  });

  it("delivery-masked sales: soh +40 while soo -100 → estUnitsSold 60", () => {
    const result = classifyMovement([
      { soh: 10,  soo: 200 },
      { soh: 50,  soo: 100 },
    ]);
    expect(result.estUnitsSold).toBe(60);
  });

  it("no movement: flat SOH returns 0", () => {
    const result = classifyMovement([
      { soh: 50, soo: 0 },
      { soh: 50, soo: 0 },
    ]);
    expect(result.estUnitsSold).toBe(0);
  });

  it("skips intervals where prev soh is null", () => {
    const result = classifyMovement([
      { soh: null, soo: 0 },
      { soh: 80,   soo: 0 },
      { soh: 60,   soo: 0 },
    ]);
    expect(result.estUnitsSold).toBe(20);
  });
});

describe("weekly sell-through rate", () => {
  it("coverage-normalised: 486 units over 22 days ≈ 154.6/wk (not 113.4)", () => {
    // 113.4 would be wrong (486/30*7 — using window not actual span)
    // Correct: 486/22*7 = 154.636... → 154.6
    const snapshots = [
      { soh: 1000, soo: 0,  date: "2026-06-01" },
      { soh: 514,  soo: 0,  date: "2026-06-23" }, // 22 days later, -486 units
    ];
    const rate = weeklyRate(snapshots);
    expect(rate).toBe(154.6);
  });

  it("insufficient data: daysCovered < 7 → null", () => {
    const snapshots = [
      { soh: 100, soo: 0, date: "2026-06-01" },
      { soh: 80,  soo: 0, date: "2026-06-05" }, // 4 days
    ];
    expect(weeklyRate(snapshots)).toBeNull();
  });

  it("insufficient data: single snapshot → null", () => {
    const snapshots = [{ soh: 100, soo: 0, date: "2026-06-01" }];
    expect(weeklyRate(snapshots)).toBeNull();
  });

  it("zero sales: estWeeklyST = 0.0 when no SOH change", () => {
    const snapshots = [
      { soh: 50, soo: 0, date: "2026-06-01" },
      { soh: 50, soo: 0, date: "2026-06-15" },
    ];
    expect(weeklyRate(snapshots)).toBe(0);
  });

  it("multi-interval accumulation over 14 days", () => {
    // 100→80 (−20) then 80→60 (−20) = 40 units over 14 days → 40/14*7 = 20.0
    const snapshots = [
      { soh: 100, soo: 0, date: "2026-06-01" },
      { soh: 80,  soo: 0, date: "2026-06-08" },
      { soh: 60,  soo: 0, date: "2026-06-15" },
    ];
    expect(weeklyRate(snapshots)).toBe(20);
  });
});
