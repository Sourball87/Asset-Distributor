import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  stripFences,
  makeQueryHash,
  callLlmJudge,
  LlmCapExceededError,
  LlmUnavailableError,
  DAILY_LLM_CAP,
  extractFormFactor,
  extractCpuFamily,
  applyDeterministicGuard,
} from "./market-price-llm";

// ── stripFences ────────────────────────────────────────────────────────────

describe("stripFences", () => {
  it("strips ```json fences", () => {
    const input = '```json\n{"matches":[]}\n```';
    expect(stripFences(input)).toBe('{"matches":[]}');
  });

  it("strips plain ``` fences", () => {
    const input = '```\n{"matches":[]}\n```';
    expect(stripFences(input)).toBe('{"matches":[]}');
  });

  it("leaves bare JSON untouched", () => {
    const input = '{"matches":[]}';
    expect(stripFences(input)).toBe('{"matches":[]}');
  });

  it("handles leading/trailing whitespace inside fences", () => {
    const input = '```json\n  {"matches":[]}\n  \n```';
    expect(JSON.parse(stripFences(input))).toEqual({ matches: [] });
  });
});

// ── makeQueryHash ──────────────────────────────────────────────────────────

describe("makeQueryHash", () => {
  it("returns a 64-char hex string", () => {
    const h = makeQueryHash("product:123:some desc");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(makeQueryHash("x")).toBe(makeQueryHash("x"));
  });

  it("differs for different inputs", () => {
    expect(makeQueryHash("a")).not.toBe(makeQueryHash("b"));
  });
});

// ── callLlmJudge — out-of-range index dropped ─────────────────────────────

describe("callLlmJudge — index guardrail", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("drops indices not in the candidate list", async () => {
    // Mock Anthropic client response returning indices 0, 5 (5 is out of range for 3 candidates)
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => ({
            content: [{ type: "text", text: '{"matches":[{"index":0,"similarity":"close","reason":"r"},{"index":5,"similarity":"partial","reason":"x"}]}' }],
          }),
        };
      },
    }));

    // Re-import after mock so the module picks up the mock
    const { callLlmJudge: judge } = await import("./market-price-llm");

    const candidates = [
      { index: 0, brand: "NETGEAR", vpnDisplay: "GS308", description: "8-port unmanaged switch" },
      { index: 1, brand: "TP-LINK", vpnDisplay: "TL-SG108", description: "8-port gigabit switch" },
      { index: 2, brand: "CISCO", vpnDisplay: "SG110-08", description: "8-port desktop switch" },
    ];

    const result = await judge("8-port gigabit switch", candidates);

    // Index 5 must be dropped; index 0 must be kept
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.index).toBe(0);
  });
});

// ── callLlmJudge — fenced JSON parsed correctly ───────────────────────────

describe("callLlmJudge — fenced JSON handling", () => {
  it("parses fenced JSON from LLM response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => ({
            content: [{ type: "text", text: '```json\n{"matches":[{"index":0,"similarity":"close","reason":"matches"}]}\n```' }],
          }),
        };
      },
    }));

    const { callLlmJudge: judge } = await import("./market-price-llm");

    const candidates = [
      { index: 0, brand: "DELL", vpnDisplay: "X1000", description: "laptop" },
    ];

    const result = await judge("laptop", candidates);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.similarity).toBe("close");
  });
});

// ── LlmCapExceededError ────────────────────────────────────────────────────

describe("LlmCapExceededError", () => {
  it("has status 429", () => {
    const err = new LlmCapExceededError();
    expect(err.status).toBe(429);
    expect(err.message).toContain(String(DAILY_LLM_CAP));
  });
});

// ── LlmUnavailableError ────────────────────────────────────────────────────

describe("LlmUnavailableError", () => {
  it("has status 502", () => {
    const err = new LlmUnavailableError("timeout");
    expect(err.status).toBe(502);
    expect(err.message).toBe("timeout");
  });
});

// ── extractFormFactor ──────────────────────────────────────────────────────

describe("extractFormFactor", () => {
  it("extracts SFF from Lenovo desktop description", () => {
    expect(extractFormFactor("LENOVO NEO 50S G5 SFF I7-13700, 512GB, 16GB, W11P, 3YOS")).toBe("SFF");
  });

  it("extracts MFF when MFF is present alongside DESKTOP", () => {
    expect(extractFormFactor("DELL PRO DESKTOP, MICRO (MFF), I7-14700T, 16GB, 512GB, W11P")).toBe("MFF");
  });

  it("extracts MINI for HP Mini descriptions", () => {
    expect(extractFormFactor("HP 400 G9 MINI I5-14500T 16GB 512GB W11P WL BT 3YR")).toBe("MINI");
  });

  it("extracts SFF when SLIM (SFF) pattern present", () => {
    expect(extractFormFactor("DELL PRO DESKTOP, SLIM (SFF), I5-14500, 16GB, 512GB, W11P")).toBe("SFF");
  });

  it("returns null for a laptop description (no form-factor token)", () => {
    expect(extractFormFactor("DELL LATITUDE 5540 I7-1365U 16GB 512GB W11P 1YR")).toBeNull();
  });

  it("returns null for a monitor", () => {
    expect(extractFormFactor("DELL U2722D 27IN ULTRASHARP USB-C 4K IPS MONITOR")).toBeNull();
  });
});

// ── extractCpuFamily ──────────────────────────────────────────────────────

describe("extractCpuFamily", () => {
  it("extracts I7 from i7-13700", () => {
    expect(extractCpuFamily("LENOVO NEO 50S G5 SFF I7-13700, 512GB")).toBe("I7");
  });

  it("extracts I5 from i5-14500", () => {
    expect(extractCpuFamily("DELL PRO DESKTOP SFF I5-14500 16GB 512GB W11P")).toBe("I5");
  });

  it("extracts I5 from i5-14500T (suffix variant)", () => {
    expect(extractCpuFamily("HP 400 G9 MINI I5-14500T 16GB 512GB W11P")).toBe("I5");
  });

  it("extracts U7 from U7-265", () => {
    expect(extractCpuFamily("DELL PRO DESKTOP SLIM (SFF) U7-265 16GB 512GB W11P")).toBe("U7");
  });

  it("extracts I7 from i7-14700T (trailing letter)", () => {
    expect(extractCpuFamily("DELL PRO DESKTOP MICRO (MFF) I7-14700T 16GB 512GB W11P 3YOS")).toBe("I7");
  });

  it("returns null for a monitor with no CPU token", () => {
    expect(extractCpuFamily("DELL U2722D 27IN ULTRASHARP USB-C 4K IPS MONITOR")).toBeNull();
  });
});

// ── applyDeterministicGuard ───────────────────────────────────────────────

describe("applyDeterministicGuard", () => {
  const m = (
    description: string,
    similarity: "close" | "partial" | "related",
    reason = "matches well",
  ) => ({ description, similarity, reason });

  const LENOVO_SFF_I7 = "LENOVO NEO 50S G5 SFF I7-13700, 512GB, 16GB, W11P, 3YOS";

  it("demotes close→partial when CPU tiers differ (i5 vs i7)", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("ASUS ExpertCentre D701S SFF PC, Intel Core i5-14500, DDR5 16GB, 512GB, W11P, 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("[tier differs]");
  });

  it("demotes close→partial when form factors differ (MFF vs SFF)", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("DELL PRO DESKTOP, MICRO (MFF), I7-14700T, 16GB, 512GB, W11P, WL, 3YOS", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("[form-factor differs]");
  });

  it("appends both tags when CPU and form factor both differ", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("DELL PRO DESKTOP, MICRO (MFF), I5-14500, 16GB, 512GB, W11P, 1YOS", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("form-factor differs");
    expect(result[0]!.reason).toContain("tier differs");
  });

  it("leaves match untouched when CPU tier AND form factor both match", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("DELL PRO DESKTOP, SLIM (SFF), I7-14700, 16GB, 512GB, W11P, 3YOS", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
    expect(result[0]!.reason).toBe("matches well");
  });

  it("leaves match untouched when source has no extractable tokens", () => {
    const noTokenSource = "GENERIC PRODUCT 16GB 512GB";
    const result = applyDeterministicGuard(noTokenSource, [
      m("ASUS SFF I5-14500 16GB 512GB W11P", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("leaves match untouched when candidate has no extractable CPU token", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("SOME PRODUCT SFF 16GB 512GB WITHOUT CPU SPEC", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("does not demote a match already at partial", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("ASUS SFF I5-14500 16GB 512GB W11P", "partial", "one gen older"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toBe("one gen older");
  });

  it("does not touch related matches", () => {
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [
      m("ASUS VIVO AIO I5-14500 OPEN BOX", "related", "refurb"),
    ]);
    expect(result[0]!.similarity).toBe("related");
    expect(result[0]!.reason).toBe("refurb");
  });

  it("preserves all other fields on the match object (non-destructive spread)", () => {
    const extra = {
      description: "DELL SFF I5-14500 16GB 512GB W11P",
      similarity: "close" as const,
      reason: "close match",
      productId: 9999,
      brand: "DELL",
      vpnDisplay: "BST999",
      prices: [],
    };
    const result = applyDeterministicGuard(LENOVO_SFF_I7, [extra]);
    expect(result[0]!.productId).toBe(9999);
    expect(result[0]!.brand).toBe("DELL");
    expect(result[0]!.vpnDisplay).toBe("BST999");
    expect(result[0]!.similarity).toBe("partial");
  });
});
