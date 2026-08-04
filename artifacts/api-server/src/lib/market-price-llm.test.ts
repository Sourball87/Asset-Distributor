import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stripFences,
  extractJsonFromLlmText,
  makeQueryHash,
  callLlmJudge,
  LlmCapExceededError,
  LlmUnavailableError,
  DAILY_LLM_CAP,
  extractFormFactor,
  extractCpuFamily,
  applyDeterministicGuard,
  buildTokenGroups,
  detectClassHint,
  sortMatchesBySimilarity,
  SIMILARITY_RANK,
  detectProductTier,
  FAMILY_TIER_MAP,
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

// ── extractJsonFromLlmText ────────────────────────────────────────────────

describe("extractJsonFromLlmText", () => {
  it("parses clean JSON directly", () => {
    const result = extractJsonFromLlmText('{"matches":[]}');
    expect(result).toEqual({ matches: [] });
  });

  it("parses fenced JSON after stripping fences", () => {
    const result = extractJsonFromLlmText('```json\n{"matches":[]}\n```');
    expect(result).toEqual({ matches: [] });
  });

  it("extracts JSON when there is a preamble sentence before the object", () => {
    const input = 'Here are the matching candidates:\n{"matches":[{"index":0,"similarity":"close","reason":"identical specs"}]}';
    const result = extractJsonFromLlmText(input) as { matches: unknown[] };
    expect(result.matches).toHaveLength(1);
  });

  it("extracts JSON when there is trailing commentary after the object", () => {
    const input = '{"matches":[]}\nNote: no comparable products were found.';
    const result = extractJsonFromLlmText(input);
    expect(result).toEqual({ matches: [] });
  });

  it("throws on genuinely truncated JSON (no closing brace)", () => {
    const truncated = '{"matches":[{"index":0,"similarity":"close","r';
    expect(() => extractJsonFromLlmText(truncated)).toThrow();
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
    // Mock OpenAI client response returning indices 0, 5 (5 is out of range for 3 candidates)
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '{"matches":[{"index":0,"similarity":"close","reason":"r"},{"index":5,"similarity":"partial","reason":"x"}]}' }, finish_reason: "stop" }],
            }),
          },
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
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '```json\n{"matches":[{"index":0,"similarity":"close","reason":"matches"}]}\n```' }, finish_reason: "stop" }],
            }),
          },
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

// ── callLlmJudge — classHint appended to user message ────────────────────

describe("callLlmJudge — classHint in user message", () => {
  // Reset module registry before each test so _client singleton is cleared
  // and vi.doMock picks up the fresh Anthropic mock.
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes COMPONENT CONTEXT line when classHint is provided", async () => {
    let capturedContent = "";

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: async (opts: { messages: Array<{ role: string; content: string }> }) => {
              // user message is at index 1 (system is at index 0)
              capturedContent = opts.messages[1]?.content ?? "";
              return { choices: [{ message: { content: '{"matches":[]}' }, finish_reason: "stop" }] };
            },
          },
        };
      },
    }));

    const { callLlmJudge: judge } = await import("./market-price-llm");

    const candidates = [
      { index: 0, brand: "ASUS", vpnDisplay: "SSD-X1", description: "M.2 NVMe 256GB SSD" },
    ];

    await judge(
      "256gb m2",
      candidates,
      120,
      "a storage drive (SSD/NVMe/M.2); systems that contain one are NOT matches",
    );

    expect(capturedContent).toContain("COMPONENT CONTEXT:");
    expect(capturedContent).toContain("storage drive");
  });

  it("omits COMPONENT CONTEXT line when classHint is null", async () => {
    let capturedContent = "";

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: async (opts: { messages: Array<{ role: string; content: string }> }) => {
              // user message is at index 1 (system is at index 0)
              capturedContent = opts.messages[1]?.content ?? "";
              return { choices: [{ message: { content: '{"matches":[]}' }, finish_reason: "stop" }] };
            },
          },
        };
      },
    }));

    const { callLlmJudge: judge } = await import("./market-price-llm");

    const candidates = [
      { index: 0, brand: "DELL", vpnDisplay: "D001", description: "laptop 16GB 512GB" },
    ];

    await judge("i7 laptop 16gb", candidates, 120, null);

    expect(capturedContent).not.toContain("COMPONENT CONTEXT");
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
    expect(result[0]!.reason).toContain("[CPU tier differs]");
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

// ── buildTokenGroups ──────────────────────────────────────────────────────

describe("buildTokenGroups", () => {
  it("expands 'm2' to the m.2/m2 synonym group", () => {
    const groups = buildTokenGroups("256gb m2");
    const m2Group = groups.find((g) => g.variants.includes("m.2"));
    expect(m2Group).toBeDefined();
    expect(m2Group?.variants).toContain("m2");
  });

  it("expands size tokens to with/without-space variants", () => {
    const groups = buildTokenGroups("256gb ssd");
    const sizeGroup = groups.find((g) => g.variants.includes("256gb"));
    expect(sizeGroup).toBeDefined();
    expect(sizeGroup?.variants).toContain("256 gb");
  });

  it("keeps 'ssd' despite being only 3 chars (synonym map bypass)", () => {
    const groups = buildTokenGroups("ssd nvme 512gb");
    const ssdGroup = groups.find((g) => g.variants.includes("ssd"));
    expect(ssdGroup).toBeDefined();
  });

  it("filters out tokens shorter than 4 chars that are not in the synonym map", () => {
    const groups = buildTokenGroups("a pc hdd");
    // 'a' (1) and 'pc' (2) should be filtered; 'hdd' in synonym map passes
    const keys = groups.flatMap((g) => g.variants);
    expect(keys).not.toContain("a");
    expect(keys).not.toContain("pc");
    expect(keys).toContain("hdd");
  });

  it("deduplicates tokens — 'm2' and 'm.2' both normalize to the same group", () => {
    const groups = buildTokenGroups("m2 m.2 256gb");
    // Both normalize to key 'm2' → only one group for M.2
    const m2Groups = groups.filter((g) => g.variants.includes("m.2"));
    expect(m2Groups).toHaveLength(1);
  });

  it("assigns unique groupIds", () => {
    const groups = buildTokenGroups("256gb m2 ssd nvme");
    const ids = groups.map((g) => g.groupId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps output at 30 groups", () => {
    // Build a long string with many distinct 5-char tokens
    const words = Array.from({ length: 50 }, (_, i) => `word${String(i).padStart(2, "0")}`).join(" ");
    const groups = buildTokenGroups(words);
    expect(groups.length).toBeLessThanOrEqual(30);
  });

  it("returns empty array for an empty string", () => {
    expect(buildTokenGroups("")).toHaveLength(0);
  });

  it("handles 'nvme' correctly — single variant that matches NVMe in descriptions", () => {
    const groups = buildTokenGroups("nvme drive");
    const nvmeGroup = groups.find((g) => g.variants.includes("nvme"));
    expect(nvmeGroup).toBeDefined();
  });
});

// ── detectClassHint ───────────────────────────────────────────────────────

describe("detectClassHint", () => {
  it("returns a drive hint for 'ssd' without a system token", () => {
    const hint = detectClassHint("256gb ssd");
    expect(hint).not.toBeNull();
    expect(hint).toContain("storage drive");
    expect(hint).toContain("NOT matches");
  });

  it("returns a drive hint for 'm2' input", () => {
    expect(detectClassHint("256gb m2")).toContain("storage drive");
  });

  it("returns a drive hint for 'nvme' input", () => {
    expect(detectClassHint("512gb nvme")).toContain("storage drive");
  });

  it("returns a RAM hint for 'ram' input", () => {
    expect(detectClassHint("16gb ram ddr5")).toContain("memory module");
  });

  it("returns a RAM hint for 'dimm' input", () => {
    expect(detectClassHint("32gb dimm")).toContain("memory module");
  });

  it("returns a GPU hint", () => {
    expect(detectClassHint("rtx 4070 gpu")).toContain("graphics card");
  });

  it("returns a PSU hint", () => {
    expect(detectClassHint("750w psu")).toContain("power supply");
  });

  it("returns null when spec mentions 'laptop' (system token overrides)", () => {
    expect(detectClassHint("laptop ssd 512gb")).toBeNull();
  });

  it("returns null when spec mentions 'desktop'", () => {
    expect(detectClassHint("desktop with 256gb ssd")).toBeNull();
  });

  it("returns null when no component token present", () => {
    expect(detectClassHint("8-port gigabit switch")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(detectClassHint("")).toBeNull();
  });
});

// ── detectProductTier ─────────────────────────────────────────────────────

describe("detectProductTier", () => {
  // FLAGSHIP
  // ── Real stored descriptions (from live DB — use these, not idealised ones) ─
  it("detects X1 Carbon G13 Aura as flagship — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO X1 CARBON G13 AURA U7-268V VPRO, 14\" WUXGA TOUCH, 512GB, 32GB, AI, W11P(CP+),3YPREM"
    expect(detectProductTier('LENOVO X1 CARBON G13 AURA U7-268V VPRO, 14" WUXGA TOUCH, 512GB, 32GB, AI, W11P(CP+),3YPREM')).toBe("flagship");
  });
  it("detects EliteBook Ultra G1I as flagship — real DB description", () => {
    // Stored as: "ELITEBOOK ULTRA G1I 14 AI U5-226V16GB 512GB W11P STD TS WL BT L-LIFE BATT 3YR DIB"
    expect(detectProductTier("ELITEBOOK ULTRA G1I 14 AI U5-226V16GB 512GB W11P STD TS WL BT L-LIFE BATT 3YR DIB")).toBe("flagship");
  });
  it("detects EliteBook X Flip G1I as flagship — real DB description", () => {
    // Stored as: "ELITEBOOK X FLIP G1I 14 AI U5-226V 16GB 512GB W11P STD TS PVCY WL BT L-LIFE BATT PEN 3YR 5"
    expect(detectProductTier("ELITEBOOK X FLIP G1I 14 AI U5-226V 16GB 512GB W11P STD TS PVCY WL BT L-LIFE BATT PEN 3YR 5")).toBe("flagship");
  });
  it("detects HP ProBook 4 G1i as value — real DB description", () => {
    // Stored as: "HP ProBook 4 G1i BP9F2PT, U5-225U, 16GB, 512GB, 14\" WUXGA IR TOUCH, W11P, 1Y OS"
    expect(detectProductTier('HP ProBook 4 G1i BP9F2PT, U5-225U, 16GB, 512GB, 14" WUXGA IR TOUCH, W11P, 1Y OS')).toBe("value");
  });
  it("detects HP ProBook 440 G11 as value — real DB description", () => {
    // Stored as: "HP ProBook 440 G11 14' WUXGA Intel U5-125U 16GB DDR5 512GB SSD Windows 11 PRO…"
    expect(detectProductTier("HP ProBook 440 G11 14' WUXGA Intel U5-125U 16GB DDR5 512GB SSD Windows 11 PRO")).toBe("value");
  });
  it("detects ThinkBook 14 2-in-1 as value — real DB description with BOX DAMAGE prefix", () => {
    // Stored as: "BOX DAMAGE Lenovo ThinkBook 14 2-in-1 G5 U5-225U, 16GB, 512GB, 14\" WUXGA TOUCH, W11P, 1Y OS"
    expect(detectProductTier('BOX DAMAGE Lenovo ThinkBook 14 2-in-1 G5 U5-225U, 16GB, 512GB, 14" WUXGA TOUCH, W11P, 1Y OS')).toBe("value");
  });
  it("detects T14 G7 as mainstream — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO T14 G7 AMD R5-230, 14\" WUXGA, 512GB, 16GB, W11P, 3YR PREM"
    expect(detectProductTier('LENOVO T14 G7 AMD R5-230, 14" WUXGA, 512GB, 16GB, W11P, 3YR PREM')).toBe("mainstream");
  });
  it("detects T14S G6 as mainstream — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO T14S G6 X ELITE (X1E-78)14\" WUXGA TOUCH, 512GB32GB, W11P, 3YR PREM"
    expect(detectProductTier('LENOVO T14S G6 X ELITE (X1E-78)14" WUXGA TOUCH, 512GB32GB, W11P, 3YR PREM')).toBe("mainstream");
  });
  it("detects T16 G4 as mainstream — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO T16 G4 U5-225H, 16\" WUXGA, 512GB, 16GB, W11P(AI), 3YR PREM"
    expect(detectProductTier('LENOVO T16 G4 U5-225H, 16" WUXGA, 512GB, 16GB, W11P(AI), 3YR PREM')).toBe("mainstream");
  });
  it("detects T14S 2-in-1 G1 as mainstream — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO T14S 2IN1 G1 U7-255H, 14\" WUXGA TOUCH, 512GB, 32GB, W11P(AI), 3YR PREM"
    expect(detectProductTier('LENOVO T14S 2IN1 G1 U7-255H, 14" WUXGA TOUCH, 512GB, 32GB, W11P(AI), 3YR PREM')).toBe("mainstream");
  });
  it("detects L14 G6 as value — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO L14 G6 AMD R5-215, 14\" WUXGA, 512GB, 16GB, W11P, 3YOS"
    expect(detectProductTier('LENOVO L14 G6 AMD R5-215, 14" WUXGA, 512GB, 16GB, W11P, 3YOS')).toBe("value");
  });
  it("detects L16 G2 as value — real DB description, no THINKPAD prefix", () => {
    // Stored as: "LENOVO L16 G2 U5-225U, 16\" WUXGA, 512GB, 32GB, W11P (AI), 3YOS"
    expect(detectProductTier('LENOVO L16 G2 U5-225U, 16" WUXGA, 512GB, 32GB, W11P (AI), 3YOS')).toBe("value");
  });
  it("detects DEMO L16 G2 as value — real DB description with DEMO prefix", () => {
    // Stored as: "DEMO LENOVO L16 G2 U5-225U, 16\" WUXGA, 512GB, 32GB, W11P (AI), 3YOS (OPENED BOX)"
    expect(detectProductTier('DEMO LENOVO L16 G2 U5-225U, 16" WUXGA, 512GB, 32GB, W11P (AI), 3YOS (OPENED BOX)')).toBe("value");
  });
  it("detects HP ZBook Firefly G11 as mainstream — real DB description", () => {
    // Stored as: "HP ZBook FireFly G11 14' WUXGA TOUCH Intel AI U7-155H 16GB DDR5 512GB SSD WIN 11 PRO..."
    expect(detectProductTier("HP ZBook FireFly G11 14' WUXGA TOUCH Intel AI U7-155H 16GB DDR5 512GB SSD WIN 11 PRO Arc GPU")).toBe("mainstream");
  });
  it("detects HP ZBook 8 G1i FireFly as mainstream — real DB description", () => {
    // Stored as: "HP ZBook 8 G1i FireFly 16' WUXGA Touch IR Intel U5-225H 16GB DDR5 512GB SSD WIN 11 PRO..."
    expect(detectProductTier("HP ZBook 8 G1i FireFly 16' WUXGA Touch IR Intel U5-225H 16GB DDR5 512GB SSD WIN 11 PRO")).toBe("mainstream");
  });
  // ── Dell Pro — real stored descriptions (confirmed StockedItem candidates from DB) ──
  it("detects Dell Pro 3 14\" as value — real DB description [CTO515_P314260_AU]", () => {
    // Stored as: "DELL PRO 3 NOTEBOOK, 14\" FHD+IR, CORE 5-320, 16GB, 512GB, WL, W11P(AI), BLACK, 1YOS"
    expect(detectProductTier('DELL PRO 3 NOTEBOOK, 14" FHD+IR, CORE 5-320, 16GB, 512GB, WL, W11P(AI), BLACK, 1YOS')).toBe("value");
  });
  it("detects Dell Pro 3 16\" as value — real DB description [CTO515_P316260_AU]", () => {
    // Stored as: "DELL PRO 3 NOTEBOOK, 16\" FHD+, CORE 5-320, 16GB, 512GB, WL, W11P(AI), BLACK, 1YOS"
    expect(detectProductTier('DELL PRO 3 NOTEBOOK, 16" FHD+, CORE 5-320, 16GB, 512GB, WL, W11P(AI), BLACK, 1YOS')).toBe("value");
  });
  it("detects Dell Pro 5 14\" notebook as mainstream — real DB description [CTO515_P514260_AU]", () => {
    // Stored as: "DELL PRO 5 NOTEBOOK, 14\" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+), 3YOS"
    expect(detectProductTier('DELL PRO 5 NOTEBOOK, 14" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+), 3YOS')).toBe("mainstream");
  });
  it("detects Dell Pro 5 desktop MFF as mainstream — real DB description [BTP104_QCM1250_AU3Y via bundle]", () => {
    // Stored as: "DELL PRO DESKTOP, MICRO (MFF), U5-235T, 16GB, 512GB, WL, W11P(AI), 3YOS"
    // Note: matches /\bdell\s+pro\s+desktop\b/i (generic Pro Desktop pattern), not /\bdell\s+pro\s*5\b/i
    expect(detectProductTier("DELL PRO DESKTOP, MICRO (MFF), U5-235T, 16GB, 512GB, WL, W11P(AI), 3YOS")).toBe("mainstream");
  });
  it("detects Dell Pro 5 desktop SFF as mainstream — real DB description [BTP009_QCS1250_AU]", () => {
    expect(detectProductTier("DELL PRO DESKTOP, SLIM (SFF), i5-14500, 16GB, 512GB, NO-WL, W11P, 3YOS")).toBe("mainstream");
  });
  it("detects Dell Pro 7 13\" as mainstream — real DB description [CTO515_P713260_AU] (NOT value)", () => {
    // Stored as: "DELL PRO 7 NOTEBOOK, 13\" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+) 3Y PRO"
    // Price $2,999 — above Pro 5 mainstream ($2,369). Was incorrectly value in prior map.
    expect(detectProductTier('DELL PRO 7 NOTEBOOK, 13" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+) 3Y PRO')).toBe("mainstream");
  });
  it("detects Dell Pro 7 14\" as mainstream — real DB description [CTO515_P714260_AU]", () => {
    expect(detectProductTier('DELL PRO 7 NOTEBOOK, 14" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("mainstream");
  });
  it("detects Dell Pro 7 Convertible as mainstream — real DB description [CTO535_P704260_AU]", () => {
    expect(detectProductTier('DELL PRO 7 CONVERTIBLE NOTEBOOK, 14" FHD+IR TOUCH, U5-335, 32GB, 512GB, WL, W11P(CP+), 3Y')).toBe("mainstream");
  });
  it("detects Dell Pro13 Plus as mainstream — real DB description [CTO515_PB13250_AU]", () => {
    // Stored as: "DELL PRO13 PLUS NOTEBOOK, 13\" FHD+ IR, U5-236V, 16GB, 512GB, WL, W11P(CP+) 3Y PRO"
    // Previous Plus pattern used 1[46] — would have MISSED Pro13 (13 not in [46]).
    expect(detectProductTier('DELL PRO13 PLUS NOTEBOOK, 13" FHD+ IR, U5-236V, 16GB, 512GB, WL, W11P(CP+) 3Y PRO')).toBe("mainstream");
  });
  it("detects Dell Pro14 Plus as mainstream — real DB description [BTO215_PB14250_AU]", () => {
    // Stored as: "DELL PRO14 PLUS NOTEBOOK, 14\" FHD+ IR, U7-266V, 16GB, 512GB, WL, W11P(CP+), 3Y PRO"
    expect(detectProductTier('DELL PRO14 PLUS NOTEBOOK, 14" FHD+ IR, U7-266V, 16GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("mainstream");
  });
  it("detects Dell Pro16 Plus as mainstream — real DB description [BTO208_PB16250_AU]", () => {
    expect(detectProductTier('DELL PRO16 PLUS NOTEBOOK, 16" FHD+ IR, U5-236V, 16GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("mainstream");
  });
  it("detects Dell Pro13 Premium as flagship — real DB description [BTO201_PA13250_AU]", () => {
    // Stored as: "DELL PRO13 PREMIUM NOTEBOOK, 13.3\" FHD+ IR, U5-236V, 16GB, 512GB, WL, W11P(CP+), 3Y PRO"
    expect(detectProductTier('DELL PRO13 PREMIUM NOTEBOOK, 13.3" FHD+ IR, U5-236V, 16GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("flagship");
  });
  it("detects Dell Pro14 Premium as flagship — real DB description [BTO203_PA14250_AU]", () => {
    // Stored as: "DELL PRO14 PREMIUM NOTEBOOK, 14\" FHD+ IR, U5-238V, 32GB, 512GB, WL, W11P(CP+), 3Y PRO"
    expect(detectProductTier('DELL PRO14 PREMIUM NOTEBOOK, 14" FHD+ IR, U5-238V, 32GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("flagship");
  });
  it("detects Dell Pro14 E as value — real DB description [CTO515_PV14260_AU]", () => {
    // Stored as: "DELL PRO14 E NOTEBOOK, 14\" FHD+, U5-235U, 16GB, 512B, WL, W11P(AI), 1YOS"
    expect(detectProductTier('DELL PRO14 E NOTEBOOK, 14" FHD+, U5-235U, 16GB, 512B, WL, W11P(AI), 1YOS')).toBe("value");
  });
  it("detects Dell Pro14 E (older Core 5 model) as value — real DB description [PV14250B]", () => {
    // Stored as: "DELL PRO14 E NOTEBOOK, 14\" FHD+, CORE 5-120U, 16GB, 512GB, WL, W11P, 1YOS"
    expect(detectProductTier('DELL PRO14 E NOTEBOOK, 14" FHD+, CORE 5-120U, 16GB, 512GB, WL, W11P, 1YOS')).toBe("value");
  });
  it("detects Dell Pro14 NOTEBOOK (standard base) as value — real DB description [BTP105_PC14250_AU3Y]", () => {
    // Stored as: "DELL PRO14 NOTEBOOK, 14\" FHD+ IR, U5-235U, 16GB, 512GB, WL, W11P(AI), SILVER, 3YOS"
    // This is the base/standard Pro14 (no tier suffix) — cheapest notebook line at $1,949.
    expect(detectProductTier('DELL PRO14 NOTEBOOK, 14" FHD+ IR, U5-235U, 16GB, 512GB, WL, W11P(AI), SILVER, 3YOS')).toBe("value");
  });
  it("detects Dell Pro ESS Desktop as value — real DB description [BTOR003B_QVS1260_AU]", () => {
    // Stored as: "DELL PRO ESS DESKTOP, SLIM (SFF), i5-14500, 8GB, 512GB, WL, W11P, 1YOS"
    expect(detectProductTier("DELL PRO ESS DESKTOP, SLIM (SFF), i5-14500, 8GB, 512GB, WL, W11P, 1YOS")).toBe("value");
  });
  it("detects Dell Pro Essential warranty description as value (pattern coverage)", () => {
    // DPVL* VPNs are warranty upgrades — real stored form includes "DELL PRO ESSENTIAL 14 & 15..."
    expect(detectProductTier("DELL PRO ESSENTIAL 14 & 15 PV14250 / PV14255 / PV15250 / PV15255 1Y ONSITE TO 3Y PRO")).toBe("value");
  });
  it("detects Dell Pro14 Max as flagship — inferred base description form [CTO715R5_MC14250_AU]", () => {
    // Bundle: "DELL PRO14 MAX NOTEBOOK, 14\" FHD+IR, U7-265H & SD25 DOCK FOR $150"
    // Base hardware: "DELL PRO14 MAX NOTEBOOK, 14\" FHD+IR, U7-265H, 32GB, 512GB, WL, W11P(CP+), 3Y PRO"
    expect(detectProductTier('DELL PRO14 MAX NOTEBOOK, 14" FHD+IR, U7-265H, 32GB, 512GB, WL, W11P(CP+), 3Y PRO')).toBe("flagship");
  });
  it("detects Dell Pro14 Max Premium as flagship — inferred base description form", () => {
    // Bundle: "DELL PRO14 MAX PREMIUM, 14\"FHD+IR, U7-265H & BONUS SAMSUNG PHONE"
    // Previous /pro\w*\s+premium/i missed this: "PRO14 MAX PREMIUM" has "MAX" between proWORD and "premium"
    expect(detectProductTier('DELL PRO14 MAX PREMIUM NOTEBOOK, 14" FHD+IR, U7-265H, 32GB, 1TB, WL, W11P(CP+), 3Y PRO')).toBe("flagship");
  });
  it("does not misfire Dell Pro 5 pattern on keyboard (DELL KB526 PRO 5)", () => {
    // /\bdell\s+pro\s*5\b/i requires DELL immediately before PRO — KB526 is between them
    expect(detectProductTier("DELL KB526 PRO 5 WIRELESS KEYBOARD - BLACK, 3YR")).not.toBe("mainstream");
  });
  // ── Idealised descriptions (kept for regression coverage) ─────────────────
  it("detects ThinkPad X1 Carbon as flagship — THINKPAD-prefixed form", () => {
    expect(detectProductTier("LENOVO THINKPAD X1 CARBON GEN12 U7-258V 32GB 1TB")).toBe("flagship");
  });
  it("detects X1 Yoga as flagship — bare form without THINKPAD prefix", () => {
    expect(detectProductTier("LENOVO X1 YOGA G9 U7-155U 32GB 1TB TOUCH W11P")).toBe("flagship");
  });
  it("detects X9 Aura as flagship — bare form without THINKPAD prefix", () => {
    expect(detectProductTier("LENOVO X9 AURA GEN1 U7-258V 32GB 1TB W11P AI")).toBe("flagship");
  });
  it("detects ThinkPad X9 as flagship — THINKPAD-prefixed form", () => {
    expect(detectProductTier("LENOVO THINKPAD X9 AURA GEN1 U7")).toBe("flagship");
  });
  it("detects EliteBook Ultra as flagship", () => {
    expect(detectProductTier("HP ELITEBOOK ULTRA G1I 14 U7-268V 32GB 1TB W11P")).toBe("flagship");
  });
  it("detects HP Dragonfly as flagship", () => {
    expect(detectProductTier("HP ELITEBOOK DRAGONFLY G4 I7-1365U 32GB W11P")).toBe("flagship");
  });
  it("detects Dell Pro Premium as flagship", () => {
    expect(detectProductTier("DELL PRO14 PREMIUM NOTEBOOK 14 U7-268V 32GB W11P 3Y PRO")).toBe("flagship");
  });

  // MAINSTREAM COMMERCIAL
  it("detects ThinkPad T14 as mainstream", () => {
    expect(detectProductTier("LENOVO THINKPAD T14 GEN6 U7-155U 16GB 512GB W11P")).toBe("mainstream");
  });
  it("detects ThinkPad T14S as mainstream", () => {
    expect(detectProductTier("LENOVO THINKPAD T14S GEN6 U7-268V 32GB 1TB W11P")).toBe("mainstream");
  });
  it("detects ThinkPad X13 as mainstream (not flagship) — branded form", () => {
    expect(detectProductTier("LENOVO THINKPAD X13 GEN5 U5-125U 16GB 512GB W11P")).toBe("mainstream");
  });
  it("detects Lenovo X13 G6 as mainstream — bare form (THINKPAD omitted by distributor)", () => {
    // Confirmed 20+ rows of "LENOVO X13 G6/G7…" in catalogue — old pattern /thinkpad\s+x13\b/ missed all of them.
    // Fixed by adding /\blenovo\s+x13\b/i.
    expect(detectProductTier("LENOVO X13 G6 U5-225U, 13.3\" WUXGA, 512GB, 16GB, W11P(AI), 3YR PREM")).toBe("mainstream");
  });
  it("detects Lenovo X13 G7 AMD as mainstream — bare form", () => {
    expect(detectProductTier("LENOVO X13 G7 R5-440, 13.3\" WUXGA, 512GB, 16GB, W11P, 3YR PREM")).toBe("mainstream");
  });
  it("detects Lenovo X13 Detach G1 as mainstream — bare 2-in-1 form", () => {
    // Detachable commercial tablet — vPro, U5-332/U7-365; mainstream tier is correct.
    expect(detectProductTier("LENOVO X13 DETACH G1 U5-335 VPRO, 13.2\" 2.8K TOUCH, 512GB, 32GB, W11P, 3YR PREM")).toBe("mainstream");
  });
  it("detects ASUS ExpertBook 14 WUXGA (B3-series) as mainstream — real stored form", () => {
    // Old pattern /expertbook\s+b5/ never matched — B-numbers are in VPN, not descriptions.
    // Fixed to /\basus\s+expertbook\b/i covering all ExpertBook sizes/generations.
    expect(detectProductTier("ASUS ExpertBook 14 14' WUXGA Notebook Intel Core Ultra 5 225H DDR5 16GB 512GB SSD Win 11 Pro 1Y Warranty OSW + Battery")).toBe("mainstream");
  });
  it("detects ASUS ExpertBook 14 FHD (B1-series) as mainstream — real stored form", () => {
    // B1 tier is value in absolute terms but B-numbers aren't in descriptions; all ExpertBook maps to mainstream.
    expect(detectProductTier("ASUS ExpertBook 14 14' FHD Notebook AMD Ryzen 5 150 DDR5 16GB 512GB SSD Win 11 Pro 1Y OnSite Warranty + Battery")).toBe("mainstream");
  });
  it("detects ASUS ExpertBook 15 as mainstream — real stored form", () => {
    expect(detectProductTier("ASUS ExpertBook 15 15.6' FHD Notebook Intel Core 5 120U DDR5 16GB 512GB Win 11 Pro 1Y Warranty OSW + Battery")).toBe("mainstream");
  });
  it("does NOT misfire ExpertBook pattern on standalone Swift — Swift requires Acer prefix", () => {
    // /\bacer\s+swift\b/i — requires ACER before SWIFT; ROG Swift monitors must not match.
    expect(detectProductTier("ROG SWIFT OLED PG27AQDP FHD 480HZ 3Y")).toBeNull();
  });
  it("detects Acer Swift as consumer — Acer-anchored pattern", () => {
    expect(detectProductTier("ACER SWIFT 14 AI SF14-58 14\" WUXGA SNAPDRAGON X ELITE 32GB 1TB W11P")).toBe("consumer");
  });
  it("detects HP EliteBook 640 G11 as mainstream — real stored form", () => {
    // Old pattern /elitebook\s+6\b/i failed on "640" (\b not satisfied between 6 and 4).
    // Fixed to /elitebook\s+6\d{2}\b/i.
    expect(detectProductTier("HP ELITEBOOK 640 G11 I5-1335U 8GB 256GB W11P 3Y NBD")).toBe("mainstream");
  });
  it("detects HP EliteBook 650 G11 as mainstream — real stored form", () => {
    expect(detectProductTier("HP ELITEBOOK 650 G11 I5-1335U 16GB 512GB W11P 3Y NBD")).toBe("mainstream");
  });
  it("detects HP EliteBook 660 G11 as mainstream — real stored form", () => {
    expect(detectProductTier("HP ELITEBOOK 660 G11 I7-1355U 16GB 512GB W11P 3Y NBD")).toBe("mainstream");
  });
  it("detects HP EliteBook 840 G11 as mainstream — real stored form", () => {
    expect(detectProductTier("HP ELITEBOOK 840 G11 I5-1335U 16GB 512GB W11P 3Y NBD")).toBe("mainstream");
  });
  it("detects HP EliteBook 860 G11 as mainstream — real stored form", () => {
    // Old pattern /elitebook\s+8\b/i failed on "860" (\b not satisfied between 8 and 6).
    // Fixed to /elitebook\s+8\d{2}\b/i.
    expect(detectProductTier("HP ELITEBOOK 860 G11 I7-1355U 16GB 512GB W11P 3Y NBD")).toBe("mainstream");
  });
  it("does not misfire EliteBook 6xx pattern on EliteBook X (X caught by flagship first)", () => {
    // EliteBook X must remain flagship — order-dependent guard: flagship block runs before mainstream.
    expect(detectProductTier("HP ELITEBOOK X 14 G11 I7-1355U 32GB 1TB W11P 3Y")).toBe("flagship");
  });
  it("detects HP EliteBook X as flagship", () => {
    expect(detectProductTier("HP ELITEBOOK X G11 14 U5-226V 16GB 512GB W11P")).toBe("flagship");
  });
  it("detects Dell Pro Plus as mainstream", () => {
    expect(detectProductTier("DELL PRO14 PLUS NOTEBOOK 14 FHD U7-268V 32GB W11P 3Y PRO")).toBe("mainstream");
  });

  // VALUE COMMERCIAL
  it("detects ThinkPad E as value", () => {
    expect(detectProductTier("LENOVO THINKPAD E16 GEN2 U5-125U 16GB 512GB W11P")).toBe("value");
  });
  it("detects ThinkPad L as value", () => {
    expect(detectProductTier("LENOVO THINKPAD L14 GEN5 AMD RYZEN 5 16GB 512GB W11P")).toBe("value");
  });
  it("detects ThinkBook as value", () => {
    expect(detectProductTier("LENOVO THINKBOOK 14X G1 U5-226V 16GB 512GB W11P 1YOS")).toBe("value");
  });
  it("detects HP ProBook as value", () => {
    expect(detectProductTier("HP PROBOOK 440 G11 14 WUXGA U5-125U 16GB 512GB W11P")).toBe("value");
  });
  it("detects Dell Pro 7 as mainstream (NOT value) — idealised form", () => {
    // Pro 7 moved from value to mainstream: $2,999 (13\") > Pro 5 mainstream ($2,369)
    expect(detectProductTier("DELL PRO 7 NOTEBOOK, 14\" FHD+IR, U5-335, 16GB, 512GB, WL, W11P(CP+), 3Y PRO")).toBe("mainstream");
  });
  it("does not misfire Dell Pro 7 pattern on Pro 7500 (7 not at word boundary in 7500)", () => {
    // "DELL PRO 7500 DESKTOP" — 7 in 7500 is NOT at a word boundary (\b), so /\bdell\s+pro\s*7\b/ must not match.
    // Note: "DELL PRO DESKTOP 7500" correctly DOES return mainstream via the Pro Desktop pattern.
    expect(detectProductTier("DELL PRO 7500 DESKTOP I7-10700 16GB W11P")).toBeNull();
  });
  it("detects legacy DELL PRO DESKTOP 7500 as mainstream (correctly matched by Pro Desktop pattern)", () => {
    // "DELL PRO DESKTOP 7500" — matches /\bdell\s+pro\s+desktop\b/i → mainstream commercial desktop.
    expect(detectProductTier("DELL PRO DESKTOP 7500 I7-10700 16GB W11P")).toBe("mainstream");
  });

  // CONSUMER
  it("detects IdeaPad as consumer", () => {
    expect(detectProductTier("LENOVO IDEAPAD SLIM 5 U5-125U 16GB 512GB W11H")).toBe("consumer");
  });
  it("detects HP Pavilion as consumer", () => {
    expect(detectProductTier("HP PAVILION PLUS 14 OLED U7-155H 16GB 512GB W11H")).toBe("consumer");
  });
  it("detects HP Envy as consumer", () => {
    expect(detectProductTier("HP ENVY X360 14 U7-155U 16GB 512GB W11H")).toBe("consumer");
  });

  // FLAGSHIP takes priority over consumer "yoga"
  it("detects ThinkPad X1 Yoga as flagship (not consumer)", () => {
    expect(detectProductTier("LENOVO THINKPAD X1 YOGA GEN9 U7-268V 32GB 1TB W11P")).toBe("flagship");
  });

  // Unknown
  it("returns null for an unknown product line", () => {
    expect(detectProductTier("ACME WIDGET PRO 16GB 512GB W11P")).toBeNull();
  });
  it("returns null for an empty string", () => {
    expect(detectProductTier("")).toBeNull();
  });

  // FAMILY_TIER_MAP has entries
  it("FAMILY_TIER_MAP covers all four tiers", () => {
    const tiers = new Set(FAMILY_TIER_MAP.map((e) => e.tier));
    expect(tiers).toContain("flagship");
    expect(tiers).toContain("mainstream");
    expect(tiers).toContain("value");
    expect(tiers).toContain("consumer");
  });
});

// ── applyDeterministicGuard — tier-based demotion ─────────────────────────

describe("applyDeterministicGuard — product-tier enforcement", () => {
  const sourceMainstream =
    "DELL PRO14 PLUS NOTEBOOK, 14\" FHD+ IR, U7-268V, 32GB, 512GB, WL, W11P(CP+) 3Y PRO";

  const m = (description: string, similarity: "close" | "partial" | "related", reason = "test") =>
    ({ description, similarity, reason });

  it("demotes X1 Carbon from close → partial (flagship vs mainstream source)", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("LENOVO THINKPAD X1 CARBON GEN12 U7-268V 32GB 1TB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("flagship");
    expect(result[0]!.reason).toContain("premium alternative");
  });

  it("does NOT demote T14S — same mainstream tier as source", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("LENOVO THINKPAD T14S GEN6 U7-268V 32GB 1TB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("does NOT demote EliteBook 6 — same mainstream tier as source", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("HP ELITEBOOK 6 G1I 14 U7-255U 32GB 512GB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("demotes EliteBook Ultra from close → partial (flagship vs mainstream)", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("HP ELITEBOOK ULTRA G1I 14 U7-268V 32GB 1TB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("flagship");
  });

  it("demotes EliteBook X from close → partial (flagship vs mainstream)", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("HP ELITEBOOK X G1I 14 AI U7-258V 32GB 512GB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("flagship");
    expect(result[0]!.reason).toContain("premium alternative");
  });

  it("demotes ThinkBook from close → partial (value vs mainstream source)", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("LENOVO THINKBOOK 14X G1 U7-268V 32GB 512GB W11P 1YOS", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toContain("value commercial");
  });

  it("does not demote when candidate tier is unknown (unknown brands stay as-is)", () => {
    const result = applyDeterministicGuard(sourceMainstream, [
      m("ACME BUSINESS PRO 14 U7-268V 32GB 512GB W11P 3Y", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("does not demote when source tier is unknown", () => {
    const unknownSource = "GENERIC NOTEBOOK 14 U7-268V 32GB 512GB W11P";
    const result = applyDeterministicGuard(unknownSource, [
      m("LENOVO THINKPAD X1 CARBON GEN12 U7-268V 32GB 1TB W11P", "close"),
    ]);
    // source tier unknown → no tier demotion; CPU same → no CPU demotion
    expect(result[0]!.similarity).toBe("close");
  });
});

// ── sortMatchesBySimilarity ────────────────────────────────────────────────

describe("sortMatchesBySimilarity", () => {
  it("orders close before partial before related", () => {
    const input = [
      { index: 0, similarity: "related", reason: "r" },
      { index: 1, similarity: "close",   reason: "c" },
      { index: 2, similarity: "partial", reason: "p" },
    ];
    const result = sortMatchesBySimilarity(input);
    expect(result.map((m) => m.similarity)).toEqual(["close", "partial", "related"]);
  });

  it("is stable within each tier — preserves original order for same similarity", () => {
    const input = [
      { index: 0, similarity: "partial", reason: "first partial" },
      { index: 1, similarity: "close",   reason: "only close" },
      { index: 2, similarity: "partial", reason: "second partial" },
      { index: 3, similarity: "related", reason: "only related" },
    ];
    const result = sortMatchesBySimilarity(input);
    expect(result[0]!.similarity).toBe("close");
    expect(result[1]!.index).toBe(0); // first partial stays before second
    expect(result[2]!.index).toBe(2);
    expect(result[3]!.similarity).toBe("related");
  });

  it("returns an empty array unchanged", () => {
    expect(sortMatchesBySimilarity([])).toEqual([]);
  });

  it("leaves an already-sorted array unchanged in content", () => {
    const input = [
      { index: 0, similarity: "close",   reason: "a" },
      { index: 1, similarity: "partial", reason: "b" },
      { index: 2, similarity: "related", reason: "c" },
    ];
    expect(sortMatchesBySimilarity(input)).toEqual(input);
  });

  it("does not mutate the original array", () => {
    const input = [
      { index: 0, similarity: "related", reason: "r" },
      { index: 1, similarity: "close",   reason: "c" },
    ];
    const original = [...input];
    sortMatchesBySimilarity(input);
    expect(input).toEqual(original);
  });

  it("SIMILARITY_RANK assigns 0/1/2 to close/partial/related", () => {
    expect(SIMILARITY_RANK["close"]).toBe(0);
    expect(SIMILARITY_RANK["partial"]).toBe(1);
    expect(SIMILARITY_RANK["related"]).toBe(2);
  });

  it("treats unknown similarity as lowest (rank 99) — sorts to end", () => {
    const input = [
      { index: 0, similarity: "unknown", reason: "?" },
      { index: 1, similarity: "close",   reason: "c" },
    ];
    const result = sortMatchesBySimilarity(input);
    expect(result[0]!.similarity).toBe("close");
    expect(result[1]!.similarity).toBe("unknown");
  });
});

// ── applyDeterministicGuard — end-to-end integration (real DB descriptions) ──
//
// Guards against the class of bug where the LLM rates a flagship product "close"
// against a mainstream source (or value vs mainstream) and the code guard silently
// misses it because the stored description doesn't match the expected pattern.
// Uses the actual strings returned by the DB so new distributor format changes
// that break detection are caught before they reach production.

describe("applyDeterministicGuard — end-to-end with real DB descriptions", () => {
  // Real stored source description — mainstream tier
  const SOURCE_MAINSTREAM =
    'DELL PRO14 PLUS NOTEBOOK, 14" FHD+ IR, U7-268V, 32GB, 512GB, WL, W11P(CP+) 3Y PRO';

  const m = (description: string, similarity: "close" | "partial"): import("./market-price-llm").GuardableMatch =>
    ({ description, similarity, reason: "LLM said close" });

  // ── X1 Carbon — the original gap: stored without THINKPAD prefix ──────────
  it("demotes X1 Carbon G13 Aura close→partial — real DB description (flagship vs mainstream)", () => {
    // This exact string caused the production gap before the /\bx1\s+carbon\b/i fix.
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO X1 CARBON G13 AURA U7-268V VPRO, 14" WUXGA TOUCH, 512GB, 32GB, AI, W11P(CP+),3YPREM', "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toMatch(/flagship/i);
    expect(result[0]!.reason).toMatch(/premium alternative/i);
  });

  // ── EliteBook X — stored without ELITEBOOK prefix in some bundle rows ──────
  it("demotes EliteBook X Flip G1I close→partial — real DB description (flagship vs mainstream)", () => {
    // Stored as: "ELITEBOOK X FLIP G1I 14 AI U5-226V 16GB 512GB W11P STD TS PVCY WL BT L-LIFE BATT PEN 3YR 5"
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m("ELITEBOOK X FLIP G1I 14 AI U5-226V 16GB 512GB W11P STD TS PVCY WL BT L-LIFE BATT PEN 3YR 5", "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toMatch(/flagship/i);
  });

  // ── T14 bare form — the NEW pattern: must NOT be demoted (same tier) ────────
  it("does NOT demote T14 G7 bare form — real DB description (mainstream vs mainstream)", () => {
    // Stored as: "LENOVO T14 G7 AMD R5-230, 14\" WUXGA, 512GB, 16GB, W11P, 3YR PREM"
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO T14 G7 AMD R5-230, 14" WUXGA, 512GB, 16GB, W11P, 3YR PREM', "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("does NOT demote T14S G6 bare form — real DB description (mainstream vs mainstream)", () => {
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO T14S G6 X ELITE (X1E-78)14" WUXGA TOUCH, 512GB32GB, W11P, 3YR PREM', "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  it("T16 G4 is demoted by form-factor guard (16\" vs 14\" source) — not a tier issue", () => {
    // T16 G4 is mainstream tier (same as source) so tier guard does NOT fire,
    // but the form-factor guard DOES fire: source is 14", T16 is 16".
    // This test documents the correct combined-guard behaviour.
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO T16 G4 U5-225H, 16" WUXGA, 512GB, 16GB, W11P(AI), 3YR PREM', "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial"); // form-factor guard fires
  });

  // ── L14/L16 bare form — value vs mainstream must be demoted ─────────────────
  it("demotes L14 G6 bare form close→partial — real DB description (value vs mainstream)", () => {
    // Stored as: "LENOVO L14 G6 AMD R5-215, 14\" WUXGA, 512GB, 16GB, W11P, 3YOS"
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO L14 G6 AMD R5-215, 14" WUXGA, 512GB, 16GB, W11P, 3YOS', "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toMatch(/value commercial/i);
  });

  it("demotes L16 G2 bare form close→partial — real DB description (value vs mainstream)", () => {
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO L16 G2 U5-225U, 16" WUXGA, 512GB, 32GB, W11P (AI), 3YOS', "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toMatch(/value commercial/i);
  });

  // ── ThinkBook bare form (mixed-case real description) ─────────────────────
  it("demotes ThinkBook 14 2-in-1 close→partial — real DB description incl. BOX DAMAGE prefix", () => {
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('BOX DAMAGE Lenovo ThinkBook 14 2-in-1 G5 U5-225U, 16GB, 512GB, 14" WUXGA TOUCH, W11P, 1Y OS', "close"),
    ]);
    expect(result[0]!.similarity).toBe("partial");
    expect(result[0]!.reason).toMatch(/value commercial/i);
  });

  // ── ZBook — must be mainstream (not demoted against mainstream source) ──────
  it("does NOT demote ZBook Firefly G11 — real DB description (mainstream vs mainstream)", () => {
    const result = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m("HP ZBook FireFly G11 14' WUXGA TOUCH Intel AI U7-155H 16GB DDR5 512GB SSD WIN 11 PRO Arc GPU", "close"),
    ]);
    expect(result[0]!.similarity).toBe("close");
  });

  // ── Mixed batch — verifies guard handles multiple candidates at once ────────
  it("processes a mixed batch correctly — demotes flagship+value, passes mainstream", () => {
    const results = applyDeterministicGuard(SOURCE_MAINSTREAM, [
      m('LENOVO X1 CARBON G13 AURA U7-268V VPRO, 14" WUXGA TOUCH, 512GB, 32GB, AI, W11P(CP+),3YPREM', "close"), // flagship → partial
      m('LENOVO T14 G7 AMD R5-230, 14" WUXGA, 512GB, 16GB, W11P, 3YR PREM', "close"),                          // mainstream → close
      m('LENOVO L14 G6 AMD R5-215, 14" WUXGA, 512GB, 16GB, W11P, 3YOS', "close"),                              // value → partial
    ]);
    expect(results[0]!.similarity).toBe("partial"); // X1 Carbon demoted
    expect(results[1]!.similarity).toBe("close");   // T14 unchanged
    expect(results[2]!.similarity).toBe("partial"); // L14 demoted
  });
});
