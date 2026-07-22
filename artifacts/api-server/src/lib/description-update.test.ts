import { describe, it, expect } from "vitest";
import { shouldUpdateDescription } from "./description-update";

describe("shouldUpdateDescription — longest-wins rule (≥30% longer replaces stored)", () => {
  it("null stored → always replaced by any non-empty incoming", () => {
    expect(shouldUpdateDescription(null, "any text")).toBe(true);
  });

  it("empty stored → always replaced by any non-empty incoming", () => {
    expect(shouldUpdateDescription("", "any text")).toBe(true);
  });

  it("undefined stored → always replaced", () => {
    expect(shouldUpdateDescription(undefined, "any text")).toBe(true);
  });

  it("incoming exactly 30% longer → replaces (boundary inclusive)", () => {
    // stored=10 chars, incoming=13 chars → 13 >= 10*1.3 = 13 → true
    const stored = "0123456789"; // 10 chars
    const incoming = "0123456789abc"; // 13 chars
    expect(stored.length).toBe(10);
    expect(incoming.length).toBe(13);
    expect(shouldUpdateDescription(stored, incoming)).toBe(true);
  });

  it("incoming 29% longer → does NOT replace (just under threshold)", () => {
    // stored=10 chars, incoming=12 chars → 12 < 10*1.3 = 13 → false
    const stored = "0123456789"; // 10 chars
    const incoming = "0123456789ab"; // 12 chars
    expect(shouldUpdateDescription(stored, incoming)).toBe(false);
  });

  it("incoming shorter than stored → does NOT replace", () => {
    expect(shouldUpdateDescription("long stored description here", "short")).toBe(false);
  });

  it("incoming same length as stored → does NOT replace (0% longer)", () => {
    expect(shouldUpdateDescription("hello world!", "hello world?")).toBe(false);
  });

  it("rich Ingram-style vs sparse description → replaces", () => {
    const stored = "DELL SRV R740"; // 13 chars
    const incoming =
      'DELL POWEREDGE R740 2U SERVER, 2x XEON GOLD 6130 2.1GHZ 16C, 128GB DDR4, 4x 2TB SAS 7.2K 3.5", H730P RAID, 2x 750W PSU, IDRAC9 ENT'; // well over 30% longer
    expect(shouldUpdateDescription(stored, incoming)).toBe(true);
  });

  it("incoming empty → does NOT replace (zero-length never wins)", () => {
    // 0 >= stored.length * 1.3 only if stored is also empty; 0 >= 5*1.3=6.5 → false
    expect(shouldUpdateDescription("hello", "")).toBe(false);
  });

  it("both empty → no-op (technically replaces but value is same)", () => {
    // 0 >= 0*1.3=0 → true, but both values are "" so it makes no difference
    expect(shouldUpdateDescription("", "")).toBe(true);
  });
});
