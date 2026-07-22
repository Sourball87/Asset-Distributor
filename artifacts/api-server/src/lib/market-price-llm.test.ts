import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripFences, makeQueryHash, callLlmJudge, LlmCapExceededError, LlmUnavailableError, DAILY_LLM_CAP } from "./market-price-llm";

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
