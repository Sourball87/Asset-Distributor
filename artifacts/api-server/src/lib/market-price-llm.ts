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
import { logger } from "./logger";
import { db } from "@workspace/db";
import { marketPriceLlmCallsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────

export const LLM_MODEL = "claude-sonnet-5";
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

/**
 * Robustly extract and parse a JSON object from LLM output.
 *
 * Steps:
 *   1. Strip markdown fences.
 *   2. Attempt JSON.parse directly (handles clean or fence-only wrapped output).
 *   3. If that fails, find the first '{' and last '}' in the text and retry —
 *      this handles a preamble sentence before the JSON or trailing commentary.
 *   4. If that also fails, let the SyntaxError propagate (caller wraps in
 *      LlmUnavailableError).
 */
export function extractJsonFromLlmText(text: string): unknown {
  const stripped = stripFences(text);

  // Step 2: direct parse — the common case after fence stripping
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to bracket extraction
  }

  // Step 3: bracket extraction — handles preamble / trailing commentary
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return JSON.parse(stripped.slice(first, last + 1));
    // Let this throw naturally if the extracted substring is also invalid JSON
  }

  throw new SyntaxError("no JSON object found in LLM text");
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

// ── Retrieval helpers: form-factor + CPU family extraction ────────────────

/**
 * Extract the most specific form-factor token from a description, or null.
 * Priority order ensures MFF/SFF win over the generic DESKTOP token.
 */
export function extractFormFactor(desc: string): string | null {
  const tokens = ["MFF", "SFF", "MICRO", "MINI", "TOWER", "TWR", "AIO", "DESKTOP"] as const;
  const upper = desc.toUpperCase();
  for (const t of tokens) {
    // Require non-alphanumeric boundary on both sides to avoid partial matches
    if (new RegExp(`(?<![A-Z0-9])${t}(?![A-Z0-9])`).test(upper)) return t;
  }
  return null;
}

/**
 * Extract a normalised CPU family prefix from a description, or null.
 * Returns values like "I7", "I5", "U7", "R5" — identical strings mean same tier.
 * Also returns a `sqlPattern` suitable for a PostgreSQL ILIKE expression.
 */
export function extractCpuFamily(desc: string): string | null {
  const upper = desc.toUpperCase();

  // Intel Core iN-XXXX (e.g. I7-13700, I5-14500T)
  const intelCore = upper.match(/\bI([3579])-\d{4,5}/);
  if (intelCore) return `I${intelCore[1]!}`;

  // Intel Ultra U-series (e.g. U7-265, U5-125)
  const intelUltra = upper.match(/\bU([579])-\d{3}/);
  if (intelUltra) return `U${intelUltra[1]!}`;

  // AMD Ryzen R-series VPN notation (e.g. R7 7745, R5 7600)
  const amdR = upper.match(/\bR([579])\s+\d{4}/);
  if (amdR) return `R${amdR[1]!}`;

  // Ryzen spelled out (e.g. Ryzen 7, Ryzen 5)
  const ryzen = upper.match(/RYZEN\s+([579])\b/);
  if (ryzen) return `R${ryzen[1]!}`;

  // Intel Core new naming: Core 5, Core 7, Core 9
  const coreNew = upper.match(/\bCORE\s+([579])\b/);
  if (coreNew) return `CORE${coreNew[1]!}`;

  return null;
}

// ── Deterministic guard ────────────────────────────────────────────────────

export interface GuardableMatch {
  description: string;
  similarity: "close" | "partial" | "related";
  reason: string;
}

/**
 * Post-processing guard: demote "close" → "partial" when CPU tier or form
 * factor can be extracted from BOTH source and candidate descriptions and they
 * differ.  Never upgrades; never touches "related".  Token not extractable from
 * either side → no demotion (safe fallback).
 */
export function applyDeterministicGuard<T extends GuardableMatch>(
  sourceDesc: string,
  matches: T[],
): T[] {
  const sourceFf = extractFormFactor(sourceDesc);
  const sourceCpu = extractCpuFamily(sourceDesc);

  return matches.map((m) => {
    if (m.similarity !== "close") return m; // only "close" can be demoted

    const candidateFf = extractFormFactor(m.description);
    const candidateCpu = extractCpuFamily(m.description);

    const ffDiffers =
      sourceFf != null && candidateFf != null && sourceFf !== candidateFf;
    const cpuDiffers =
      sourceCpu != null && candidateCpu != null && sourceCpu !== candidateCpu;

    if (!ffDiffers && !cpuDiffers) return m;

    const tags: string[] = [];
    if (ffDiffers) tags.push("form-factor differs");
    if (cpuDiffers) tags.push("tier differs");

    return {
      ...m,
      similarity: "partial" as const,
      reason: `${m.reason} [${tags.join(", ")}]`,
    };
  });
}

// ── Token synonym groups for by-spec retrieval ────────────────────────────

/**
 * Synonym map: normalized token (lowercase alphanum) → list of ILIKE patterns.
 * Patterns are matched against LOWER(description) via ILIKE.
 *
 * Purpose: user input like "m2" or "256gb" needs to match descriptions that
 * write "M.2" or "256 GB". The OR-group approach counts a group as "matched"
 * if ANY variant in the group appears in the description.
 */
export const TOKEN_SYNONYMS: Record<string, string[]> = {
  m2:   ["m.2", "m2"],   // M.2 slot — descriptions typically write "M.2" not "M2"
  nvme: ["nvme"],
  ssd:  ["ssd"],
  hdd:  ["hdd"],
  ram:  ["ram"],
  gpu:  ["gpu"],
  psu:  ["psu"],
  dimm: ["dimm"],
};

/** Minimum token length for tokens NOT in the synonym map */
const TOKEN_MIN_LEN = 4;

/** Size unit pattern: "256gb", "512tb", "16gb", "2tb" → expand with and without space */
const SIZE_UNIT_RE = /^(\d+)(gb|tb|mb|ghz|mhz)$/;

export interface TokenGroup {
  groupId: number;
  variants: string[];
}

/**
 * Tokenize a description into OR-groups for keyword_overlap scoring.
 *
 * Each group's variants are OR'd when matching against candidate descriptions.
 * The overlap score = number of groups where at least one variant matched.
 *
 * Rules:
 * - Lowercase, replace non-alphanum-non-dot with space, split on whitespace
 * - For map lookup: strip dots from token to get the key ("m.2" → "m2")
 * - TOKEN_SYNONYMS hit: include regardless of key length, expand to variants
 * - Size tokens (e.g. "256gb"): expand to ["256gb", "256 gb"]
 * - Other tokens: include only if key length >= TOKEN_MIN_LEN
 * - Max 30 groups total
 */
export function buildTokenGroups(desc: string): TokenGroup[] {
  const rawTokens = desc
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")   // keep dots so "m.2" stays intact
    .split(/\s+/)
    .filter(Boolean);

  const groups: TokenGroup[] = [];
  const seenKeys = new Set<string>();
  let gId = 0;

  for (const token of rawTokens) {
    // Key = alphanum-only (used for synonym map lookup + length check)
    const key = token.replace(/[^a-z0-9]/g, "");
    if (!key) continue;

    // Deduplicate by key
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Synonym map: bypass length filter, use synonym variants
    const synonyms = TOKEN_SYNONYMS[key];
    if (synonyms) {
      groups.push({ groupId: gId++, variants: synonyms });
      continue;
    }

    // Size unit: "256gb" → ["256gb", "256 gb"] to match both notations
    const sizeMatch = key.match(SIZE_UNIT_RE);
    if (sizeMatch) {
      const [, num, unit] = sizeMatch;
      groups.push({ groupId: gId++, variants: [`${num}${unit}`, `${num} ${unit}`] });
      continue;
    }

    // Regular token: apply min-length filter
    if (key.length < TOKEN_MIN_LEN) continue;

    groups.push({ groupId: gId++, variants: [key] });
  }

  return groups.slice(0, 30);
}

// ── Class hint detection ───────────────────────────────────────────────────

/** Component token sets → human-readable label for the judge hint */
const COMPONENT_HINT_MAP: Array<{ tokens: string[]; label: string }> = [
  {
    tokens: ["ssd", "m2", "nvme", "m.2"],
    label: "a storage drive (SSD/NVMe/M.2)",
  },
  {
    tokens: ["ram", "dimm"],
    label: "a memory module (RAM/DIMM)",
  },
  {
    tokens: ["gpu"],
    label: "a graphics card (GPU)",
  },
  {
    tokens: ["psu"],
    label: "a power supply unit (PSU)",
  },
];

/** If any of these appear in the spec, the user wants a SYSTEM → no component hint */
const SYSTEM_TOKENS = [
  "laptop", "notebook", "desktop", "workstation", "server", "tower", "aio",
];

/**
 * Detect whether a spec text is asking for a standalone component (SSD, RAM,
 * GPU, PSU) without also mentioning a system type. When detected, returns a
 * hint string to append to the LLM judge user message so that systems
 * containing the component are not incorrectly matched.
 *
 * Returns null when the spec mentions a system type or no component token.
 */
export function detectClassHint(specText: string): string | null {
  const lower = specText.toLowerCase();

  // Spec mentions a system → user wants a system, not a standalone component
  if (SYSTEM_TOKENS.some((t) => lower.includes(t))) return null;

  for (const { tokens, label } of COMPONENT_HINT_MAP) {
    if (tokens.some((t) => lower.includes(t))) {
      return `${label}; systems that contain one are NOT matches — only the standalone component qualifies`;
    }
  }

  return null;
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
assign it "related" with the condition stated in the reason, or omit it entirely — never assign "close" or "partial" to a non-new item.
Product-line tier rule: Consider product-line positioning, not just specs. Vendor commercial tiers roughly align as:
 PREMIUM/FLAGSHIP: Dell Pro Premium (ex-Latitude 9000), Lenovo ThinkPad X1/X9, HP EliteBook Ultra/Dragonfly, ASUS ExpertBook B9
 MAINSTREAM COMMERCIAL: Dell Pro Plus (ex-Latitude 5000/7000), Lenovo ThinkPad T/X13, HP EliteBook 8xx, ASUS ExpertBook B5
 VALUE COMMERCIAL/SMB: Dell Pro Base (ex-Latitude 3000), Lenovo ThinkPad E/L and ThinkBook, HP ProBook, ASUS ExpertBook B1
 CONSUMER: Dell Inspiron/XPS consumer, Lenovo IdeaPad/Yoga, HP Pavilion/Envy, ASUS Vivobook/Zenbook
A candidate from a DIFFERENT tier than the source is at most "partial", even if specs match exactly. A CONSUMER candidate against a COMMERCIAL source is at most "related". State the tier difference in the reason.
Return at most 12 matches. Each reason must be 15 words or fewer. Respond with raw JSON only — no preamble, no commentary, no markdown fences.`;

// ── Main judge call ───────────────────────────────────────────────────────

/**
 * Call the LLM to judge which candidates match the source.
 * Enforces a 60-second timeout and strips fences.
 * Does NOT check or increment the daily cap — callers must do that first.
 *
 * @param sourceDescription  Human-readable source description (product or spec text)
 * @param candidates         List of candidate products
 * @param maxCandidates      Slice candidates to this many before sending (default 120)
 * @param classHint          Optional component context appended to user message.
 *                           Use detectClassHint() to derive. When set, the judge
 *                           is warned that systems containing the component are not matches.
 * @returns Parsed LlmJudgeResult with only valid indices retained
 */
export async function callLlmJudge(
  sourceDescription: string,
  candidates: LlmCandidate[],
  maxCandidates = 120,
  classHint?: string | null,
): Promise<LlmJudgeResult> {
  const client = getClient();
  const cands = candidates.slice(0, maxCandidates);

  const lines: string[] = [`SOURCE: ${sourceDescription}`];
  if (classHint) {
    lines.push(`COMPONENT CONTEXT: The user seeks ${classHint}.`);
  }
  lines.push("", "CANDIDATES:");
  lines.push(...cands.map(
    (c) => `${c.index}. [${c.brand}] ${c.vpnDisplay} — ${c.description}`,
  ));
  const userMessage = lines.join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let rawText: string;
  let stopReason: string | null = null;
  try {
    const response = await client.messages.create(
      {
        model: LLM_MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: controller.signal },
    );
    stopReason = response.stop_reason;
    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length === 0) {
      logger.warn(
        {
          blockTypes: response.content.map((b) => b.type),
          stopReason,
          model: LLM_MODEL,
        },
        "LLM response contained no text blocks",
      );
    }
    rawText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n").trim();
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

  // Detect hard truncation before attempting parse — response was cut mid-JSON
  if (stopReason === "max_tokens") {
    logger.error(
      { rawTextLength: rawText.length, stopReason, model: LLM_MODEL },
      "LLM response truncated (max_tokens hit)",
    );
    throw new LlmUnavailableError("LLM response truncated — too many matches");
  }

  // Parse — strip fences with bracket-extraction fallback
  const validIndices = new Set(cands.map((c) => c.index));
  let parsed: LlmJudgeResult;
  try {
    parsed = extractJsonFromLlmText(rawText) as LlmJudgeResult;
  } catch {
    logger.error(
      { rawText, rawTextLength: rawText.length, stopReason, model: LLM_MODEL },
      "LLM returned unparseable JSON",
    );
    throw new LlmUnavailableError("LLM returned unparseable JSON");
  }

  // Drop any index not in the candidate list (hallucination guard)
  parsed.matches = (parsed.matches ?? []).filter((m) => validIndices.has(m.index));

  return parsed;
}
