import { describe, it, expect } from "vitest";
import { classifyMovement } from "./movement-classifier";

describe("classifyMovement", () => {
  it("pure decline: SOH falls with no SOO change", () => {
    // 100→80→50: sold 20+30=50
    const result = classifyMovement([
      { soh: 100, soo: 0 },
      { soh: 80,  soo: 0 },
      { soh: 50,  soo: 0 },
    ]);
    expect(result.estUnitsSold).toBe(50);
  });

  it("delivery-masked sales: soh +40 while soo -100 → estUnitsSold 60", () => {
    // soh_d=+40, soo_d=-100 → delivery: max(0, 100-40)=60
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
      { soh: 50, soo: 0 },
    ]);
    expect(result.estUnitsSold).toBe(0);
  });

  it("restock only (soh rises, soo rises): no sales counted", () => {
    const result = classifyMovement([
      { soh: 50, soo: 0   },
      { soh: 90, soo: 200 },
    ]);
    // soh_d=+40, soo_d=+200 → neither branch fires
    expect(result.estUnitsSold).toBe(0);
  });

  it("skips intervals where prev soh is null", () => {
    const result = classifyMovement([
      { soh: null, soo: 0 },
      { soh: 80,   soo: 0 },
      { soh: 60,   soo: 0 },
    ]);
    // first interval skipped, second: soh_d=-20
    expect(result.estUnitsSold).toBe(20);
  });

  it("single snapshot returns zero", () => {
    expect(classifyMovement([{ soh: 100, soo: 0 }]).estUnitsSold).toBe(0);
  });
});
