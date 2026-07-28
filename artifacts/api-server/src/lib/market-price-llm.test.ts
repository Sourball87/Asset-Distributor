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

// ── content-block extraction (thinking + text) ────────────────────────────

describe("content-block text extraction", () => {
  it("joins all text blocks when the first block is a thinking block", () => {
    // Simulate: response.content = [{type:"thinking",...},{type:"text",text:"..."}]
    // The fix filters to text blocks and joins; extractJsonFromLlmText then parses.
    const textBlocks = [{ type: "thinking", thinking: "Let me analyse..." }, { type: "text", text: '{"matches":[{"index":1,"similarity":"close","reason":"identical spec"}]}' }];
    const rawText = textBlocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
    expect(rawText).toBe('{"matches":[{"index":1,"similarity":"close","reason":"identical spec"}]}');
    const parsed = extractJsonFromLlmText(rawText) as { matches: unknown[] };
    expect(parsed.matches).toHaveLength(1);
  });

  it("joins multiple text blocks into one string before parsing", () => {
    const textBlocks = [
      { type: "text", text: '{"matches":[{"index":0,"similarity":"close","reason":"same tier"},' },
      { type: "text", text: '{"index":1,"similarity":"partial","reason":"lower tier"}]}' },
    ];
    const rawText = textBlocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
    // The joined string should be parseable via bracket extraction
    const parsed = extractJsonFromLlmText(rawText) as { matches: unknown[] };
    expect(parsed.matches).toHaveLength(2);
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

// ── callLlmJudge — classHint appended to user message ────────────────────

describe("callLlmJudge — classHint in user message", () => {
  // Reset module registry before each test so _client singleton is cleared
  // and vi.doMock picks up the fresh Anthropic mock.
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes COMPONENT CONTEXT line when classHint is provided", async () => {
    let capturedContent = "";

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async (opts: { messages: Array<{ role: string; content: string }> }) => {
            capturedContent = opts.messages[0]?.content ?? "";
            return { content: [{ type: "text", text: '{"matches":[]}' }] };
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

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async (opts: { messages: Array<{ role: string; content: string }> }) => {
            capturedContent = opts.messages[0]?.content ?? "";
            return { content: [{ type: "text", text: '{"matches":[]}' }] };
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
