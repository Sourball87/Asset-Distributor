import { describe, it, expect } from "vitest";
import { classifyMovement } from "./movement-classifier";

describe("classifyMovement", () => {
  it("outgoing: SOH falls, no SOO change", () => {
    const result = classifyMovement([
      { soh: 100, soo: 0 },
      { soh: 80,  soo: 0 },
    ]);
    expect(result.estUnitsOut).toBe(20);
    expect(result.unitsIn).toBe(0);
    expect(result.reorderFlag).toBe(false);
  });

  it("restock: SOH rises, SOO flat or rises", () => {
    const result = classifyMovement([
      { soh: 50, soo: 0 },
      { soh: 90, soo: 10 },
    ]);
    expect(result.estUnitsOut).toBe(0);
    expect(result.unitsIn).toBe(40);
    expect(result.reorderFlag).toBe(true); // soo_d = +10
  });

  it("delivery with masked sales: soh +40, soo -100 → estUnitsOut 60, unitsIn 40", () => {
    const result = classifyMovement([
      { soh: 10,  soo: 200 },
      { soh: 50,  soo: 100 },
    ]);
    // soh_d=+40, soo_d=-100 → delivery: estUnitsOut=max(0,100-40)=60, unitsIn=40
    expect(result.estUnitsOut).toBe(60);
    expect(result.unitsIn).toBe(40);
    expect(result.reorderFlag).toBe(false);
  });

  it("reorder only: SOH flat, SOO rises", () => {
    const result = classifyMovement([
      { soh: 50, soo: 0   },
      { soh: 50, soo: 200 },
    ]);
    expect(result.estUnitsOut).toBe(0);
    expect(result.unitsIn).toBe(0);
    expect(result.reorderFlag).toBe(true);
  });

  it("multi-interval walk accumulates correctly", () => {
    // Day 0→1: soh 100→80 (outgoing 20)
    // Day 1→2: soh 80→120, soo 0→0 (restock 40)
    // Day 2→3: soh 120→70 (outgoing 50)
    const result = classifyMovement([
      { soh: 100, soo: 0 },
      { soh: 80,  soo: 0 },
      { soh: 120, soo: 0 },
      { soh: 70,  soo: 0 },
    ]);
    expect(result.estUnitsOut).toBe(70); // 20+50
    expect(result.unitsIn).toBe(40);
    expect(result.reorderFlag).toBe(false);
  });

  it("sold-out with movement: soh 50→0→0 → estUnitsOut=50", () => {
    const result = classifyMovement([
      { soh: 50, soo: 0 },
      { soh: 0,  soo: 0 },
      { soh: 0,  soo: 0 },
    ]);
    expect(result.estUnitsOut).toBe(50);
    expect(result.unitsIn).toBe(0);
    expect(result.reorderFlag).toBe(false);
  });

  it("skips intervals where soh is null", () => {
    const result = classifyMovement([
      { soh: null, soo: 0  },
      { soh: 50,   soo: 0  },
      { soh: 30,   soo: 0  },
    ]);
    // first interval skipped (prev_soh null), second: soh_d=-20
    expect(result.estUnitsOut).toBe(20);
    expect(result.unitsIn).toBe(0);
  });

  it("single snapshot returns zero movement", () => {
    const result = classifyMovement([{ soh: 100, soo: 0 }]);
    expect(result.estUnitsOut).toBe(0);
    expect(result.unitsIn).toBe(0);
    expect(result.reorderFlag).toBe(false);
  });
});
