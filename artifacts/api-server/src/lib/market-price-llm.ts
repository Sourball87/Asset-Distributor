/**
 * LLM helper for the Market Price feature.
 *
 * Purpose: "Search a SKU and see comparable products from other brands across
 * all distributor feeds, with market pricing."
 *
 * Design:
 * - Single Anthropic client, created lazily so the server still boots without
 *   the key (the route guard will 503 before the client is used).
 * - 60-second AbortController timeout on every call.
 * - Strip ``` fences from the returned JSON.
 * - Daily cap (DAILY_LLM_CAP) enforced in DB; callers receive a 429-tagged
 *   error when the cap is exceeded.
 * - Model string is a single constant for easy swap.
 */

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { db } from "@workspace/db";
import { marketPriceLlmCallsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────

export const LLM_MODEL = "claude-haiku-4-5";
export const DAILY_LLM_CAP = 100;
const LLM_TIMEOUT_MS = 60_000;

// ── Anthropic client (lazy) ────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new LlmUnavailableError("ANTHROPIC_API_KEY is not configured");
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Error types ────────────────────────────────────────────────────────────

export class LlmCapExceededError extends Error {
  readonly status = 429;
  constructor() {
    super(`Daily LLM cap of ${DAILY_LLM_CAP} calls exceeded`);
    this.name = "LlmCapExceededError";
  }
}

export class LlmUnavailableError extends Error {
  readonly status = 502;
  constructor(msg: string) {
    super(msg);
    this.name = "LlmUnavailableError";
  }
}

// ── Daily cap ─────────────────────────────────────────────────────────────

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically increment today's call counter.
 * Throws LlmCapExceededError if the cap would be exceeded.
 * Returns the new count.
 */
export async function incrementAndCheckCap(): Promise<number> {
  const today = utcDateString();

  // Upsert row for today, then read the resulting count.
  await db
    .insert(marketPriceLlmCallsTable)
    .values({ callDate: today, callCount: 1 })
    .onConflictDoUpdate({
      target: marketPriceLlmCallsTable.callDate,
      set: { callCount: sql`${marketPriceLlmCallsTable.callCount} + 1` },
    });

  const [row] = await db
    .select({ callCount: marketPriceLlmCallsTable.callCount })
    .from(marketPriceLlmCallsTable)
    .where(eq(marketPriceLlmCallsTable.callDate, today));

  const count = row?.callCount ?? 1;
  if (count > DAILY_LLM_CAP) {
    // Roll back the increment we just added so the count stays at cap.
    await db
      .update(marketPriceLlmCallsTable)
      .set({ callCount: sql`${marketPriceLlmCallsTable.callCount} - 1` })
      .where(eq(marketPriceLlmCallsTable.callDate, today));
    throw new LlmCapExceededError();
  }

  return count;
}

/** Read today's count without incrementing — used in tests. */
export async function getTodayCallCount(): Promise<number> {
  const today = utcDateString();
  const [row] = await db
    .select({ callCount: marketPriceLlmCallsTable.callCount })
    .from(marketPriceLlmCallsTable)
    .where(eq(marketPriceLlmCallsTable.callDate, today));
  return row?.callCount ?? 0;
}

// ── Fence stripping ────────────────────────────────────────────────────────

/**
 * Strip markdown code fences (```json … ``` or ``` … ```) from LLM output.
 * Returns the raw JSON string ready for JSON.parse().
 */
export function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── Query hash ────────────────────────────────────────────────────────────

export function makeQueryHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ── LLM judge types ───────────────────────────────────────────────────────

export interface LlmCandidate {
  index: number;
  description: string;
  brand: string;
  vpnDisplay: string;
}

export interface LlmMatch {
  index: number;
  similarity: "close" | "partial" | "related";
  reason: string;
}

export interface LlmJudgeResult {
  matches: LlmMatch[];
}

// ── Prompts ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a product-matching analyst for an IT distributor. \
Given a source product and a numbered candidate list, identify which candidates are \
functional equivalents or close alternatives. Judge ONLY from the provided descriptions \
— never invent products not in the list. \
Return ONLY valid JSON (no markdown fences, no explanation) with this shape:
{"matches":[{"index":<int>,"similarity":"close|partial|related","reason":"<one sentence>"}]}
Omit candidates that are not comparable. Similarity values: \
"close" = near-identical function and spec class (same CPU tier, same form factor — e.g. U7=U7, i7=i7); \
"partial" = same function but different tier or capacity (e.g. i5 vs i7, U5 vs U7, or generation gap of 2+); \
"related" = same category but meaningfully different use case or form factor. \
CPU tier rule: a different CPU tier (i5 vs i7, U5 vs U7) or a generation gap of 2 or more makes a candidate at most "partial", never "close". \
Condition rule: if a candidate description indicates a non-new condition (OPEN BOX, EX-DEMO, REFURB, REFURBISHED, CARTON DAMAGE, DEMO, USED, etc.) \
assign it "related" with the condition stated in the reason, or omit it entirely — never assign "close" or "partial" to a non-new item.`;

// ── Main judge call ───────────────────────────────────────────────────────

/**
 * Call the LLM to judge which candidates match the source.
 * Enforces a 15-second timeout and strips fences.
 * Does NOT check or increment the daily cap — callers must do that first.
 *
 * @param sourceDescription  Human-readable source description (product or spec text)
 * @param candidates         List of candidate products
 * @returns Parsed LlmJudgeResult with only valid indices retained
 */
export async function callLlmJudge(
  sourceDescription: string,
  candidates: LlmCandidate[],
  maxCandidates = 120,
): Promise<LlmJudgeResult> {
  const client = getClient();
  const cands = candidates.slice(0, maxCandidates);

  const userMessage = [
    `SOURCE: ${sourceDescription}`,
    "",
    "CANDIDATES:",
    ...cands.map(
      (c) => `${c.index}. [${c.brand}] ${c.vpnDisplay} — ${c.description}`,
    ),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let rawText: string;
  try {
    const response = await client.messages.create(
      {
        model: LLM_MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: controller.signal },
    );
    const block = response.content[0];
    rawText = block.type === "text" ? block.text : "";
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmUnavailableError("Matching service timed out after 60s");
    }
    throw new LlmUnavailableError(
      `Anthropic API error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  // Parse — strip fences defensively
  const validIndices = new Set(cands.map((c) => c.index));
  let parsed: LlmJudgeResult;
  try {
    parsed = JSON.parse(stripFences(rawText)) as LlmJudgeResult;
  } catch {
    throw new LlmUnavailableError("LLM returned unparseable JSON");
  }

  // Drop any index not in the candidate list (hallucination guard)
  parsed.matches = (parsed.matches ?? []).filter((m) => validIndices.has(m.index));

  return parsed;
}
