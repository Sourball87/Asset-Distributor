/**
 * LLM helper for the Market Price feature.
 *
 * Purpose: "Search a SKU and see comparable products from other brands across
 * all distributor feeds, with market pricing."
 *
 * Design:
 * - Single OpenAI client, created lazily so the server still boots without
 *   the key (the route guard will 503 before the client is used).
 * - 60-second AbortController timeout on every call.
 * - Strip ``` fences from the returned JSON.
 * - Daily cap (DAILY_LLM_CAP) enforced in DB; callers receive a 429-tagged
 *   error when the cap is exceeded.
 * - Model string is a single constant for easy swap.
 */

import OpenAI from "openai";
import crypto from "crypto";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { marketPriceLlmCallsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────

export const LLM_MODEL = "gpt-4o";
export const DAILY_LLM_CAP = 100;
const LLM_TIMEOUT_MS = 60_000;

// ── OpenAI client (lazy) ───────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new LlmUnavailableError("OPENAI_API_KEY is not configured");
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

// ── Product-family tier lookup ─────────────────────────────────────────────

export type ProductTier = "flagship" | "mainstream" | "value" | "consumer";

/**
 * Ordered tier lookup — first match wins.
 * Patterns are tested case-insensitively against the full product description.
 * FLAGSHIP entries must precede MAINSTREAM so e.g. "ThinkPad X1 Yoga" →
 * flagship before the bare "yoga" consumer pattern fires.
 */
export const FAMILY_TIER_MAP: Array<{ patterns: RegExp[]; tier: ProductTier }> = [
  // ── FLAGSHIP ────────────────────────────────────────────────────────────
  {
    tier: "flagship",
    patterns: [
      /thinkpad\s+x1\b/i,       // X1 Carbon, X1 Yoga, X1 Extreme, X1 Nano
      /thinkpad\s+x9\b/i,       // X9 series
      /elitebook\s+ultra/i,     // HP EliteBook Ultra
      /elitebook\s+x\b/i,       // HP EliteBook X (flagship tier)
      /dragonfly/i,             // HP EliteBook Dragonfly
      /pro\w*\s+premium/i,      // Dell Pro Premium / Pro14 Premium (new naming)
      /latitude\s+9\d{3}/i,     // Dell Latitude 9xxx (legacy naming)
    ],
  },
  // ── MAINSTREAM COMMERCIAL ───────────────────────────────────────────────
  {
    tier: "mainstream",
    patterns: [
      /thinkpad\s+t\d/i,        // T14, T14S, T15, T16, T13 …
      /thinkpad\s+x13\b/i,      // X13 (not X1, not X9)
      /elitebook\s+6\b/i,       // HP EliteBook 6 series
      /elitebook\s+8\b/i,       // HP EliteBook 8 series
      /\bpro\s*(?:plus|1[46]\s*plus|16\s*plus)\b/i, // Dell Pro Plus / Pro14 Plus / Pro16 Plus
      /latitude\s+[57]\d{3}/i,  // Dell Latitude 5xxx / 7xxx (legacy)
      /expertbook\s+b5/i,
      /travelmate\s+p[46]/i,
      /surface\s+laptop/i,
      /surface\s+pro\b/i,
    ],
  },
  // ── VALUE COMMERCIAL ────────────────────────────────────────────────────
  {
    tier: "value",
    patterns: [
      /thinkpad\s+e\d/i,        // ThinkPad E series
      /thinkpad\s+l\d/i,        // ThinkPad L series
      /thinkbook/i,             // Lenovo ThinkBook (not ThinkPad)
      /probook/i,               // HP ProBook
      /expertbook\s+b1/i,
      /travelmate\s+p2/i,
      /travelmate\s+b\d/i,
      /\bpro\s*base\b/i,        // Dell Pro Base (new naming)
      /latitude\s+3\d{3}/i,     // Dell Latitude 3xxx (legacy)
    ],
  },
  // ── CONSUMER ────────────────────────────────────────────────────────────
  {
    tier: "consumer",
    patterns: [
      /ideapad/i,
      /\byoga\b/i,              // standalone Yoga (ThinkPad X1 Yoga already caught above)
      /pavilion/i,
      /\benvy\b/i,
      /inspiron/i,
      /vivobook/i,
      /zenbook/i,
      /\baspire\b/i,
      /\bswift\b/i,
      /\bnitro\b/i,
    ],
  },
];

/**
 * Detect the commercial tier of a product from its description.
 * Returns null when the family is not in the known map — callers treat this as
 * "unknown; trust the LLM" rather than forcing a demotion.
 */
export function detectProductTier(desc: string): ProductTier | null {
  for (const { patterns, tier } of FAMILY_TIER_MAP) {
    if (patterns.some((p) => p.test(desc))) return tier;
  }
  return null;
}

// ── Deterministic guard ────────────────────────────────────────────────────

export interface GuardableMatch {
  description: string;
  similarity: "close" | "partial" | "related";
  reason: string;
}

/** Human-readable label for a ProductTier value. */
function tierLabel(t: ProductTier): string {
  return {
    flagship:    "flagship",
    mainstream:  "mainstream commercial",
    value:       "value commercial",
    consumer:    "consumer",
  }[t];
}

export interface DeterministicGuardOptions {
  /**
   * When true, skip the product-family tier check (FAMILY_TIER_MAP).
   * CPU-tier and form-factor demotions remain active.
   * Use in "simple" prompt mode so the model's unaided tier judgment is visible.
   */
  skipTierGuard?: boolean;
}

/**
 * Post-processing guard: demote "close" → "partial" when CPU tier, form
 * factor, OR (unless skipTierGuard) product-family tier can be extracted from
 * BOTH source and candidate descriptions and they differ.
 *
 * Never upgrades; never touches "partial" or "related".
 * Token / tier not extractable from either side → no demotion (safe fallback).
 */
export function applyDeterministicGuard<T extends GuardableMatch>(
  sourceDesc: string,
  matches: T[],
  options: DeterministicGuardOptions = {},
): T[] {
  const { skipTierGuard = false } = options;
  const sourceFf   = extractFormFactor(sourceDesc);
  const sourceCpu  = extractCpuFamily(sourceDesc);
  const sourceTier = skipTierGuard ? null : detectProductTier(sourceDesc);

  return matches.map((m) => {
    if (m.similarity !== "close") return m; // only "close" can be demoted

    const candidateFf   = extractFormFactor(m.description);
    const candidateCpu  = extractCpuFamily(m.description);
    const candidateTier = skipTierGuard ? null : detectProductTier(m.description);

    const ffDiffers =
      sourceFf != null && candidateFf != null && sourceFf !== candidateFf;
    const cpuDiffers =
      sourceCpu != null && candidateCpu != null && sourceCpu !== candidateCpu;
    const tierDiffers =
      sourceTier != null && candidateTier != null && sourceTier !== candidateTier;

    if (!ffDiffers && !cpuDiffers && !tierDiffers) return m;

    const tags: string[] = [];
    if (ffDiffers)  tags.push("form-factor differs");
    if (cpuDiffers) tags.push("CPU tier differs");
    if (tierDiffers) {
      const isPremium = candidateTier === "flagship" && sourceTier === "mainstream";
      tags.push(
        `product tier: ${tierLabel(candidateTier)} vs ${tierLabel(sourceTier)} source` +
        (isPremium ? " (premium alternative)" : ""),
      );
    }

    return {
      ...m,
      similarity: "partial" as const,
      reason: `${m.reason} [${tags.join(", ")}]`,
    };
  });
}

// ── Per-brand result cap ───────────────────────────────────────────────────

/**
 * Keep at most `cap` matches per brand in the results list.
 * Applied after sorting (close → partial → related), so the retained matches
 * are always the highest-similarity ones for each brand.
 */
export function applyPerBrandCap<T extends { brand: string }>(
  matches: T[],
  cap: number,
): T[] {
  const counts = new Map<string, number>();
  return matches.filter((m) => {
    const n = (counts.get(m.brand) ?? 0) + 1;
    counts.set(m.brand, n);
    return n <= cap;
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

// ── Prompt mode ───────────────────────────────────────────────────────────

export type PromptMode = "simple" | "strict";

/**
 * Read the active prompt mode from the MARKET_PRICE_PROMPT env var.
 * Defaults to "simple" when unset or unrecognised.
 */
export function getActivePromptMode(): PromptMode {
  const val = process.env.MARKET_PRICE_PROMPT?.toLowerCase().trim();
  return val === "strict" ? "strict" : "simple";
}

// ── Prompts ───────────────────────────────────────────────────────────────

/**
 * STRICT prompt — full rulebook (tier tables, ordering rules, etc.).
 * Preserved verbatim for A/B comparison and easy revert.
 */
export const SYSTEM_PROMPT_STRICT = `You are a product-matching analyst for an IT distributor. \
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
 FLAGSHIP: Dell Pro Premium (ex-Latitude 9000), Lenovo ThinkPad X1/X9, HP EliteBook Ultra/EliteBook X/Dragonfly, ASUS ExpertBook B9
 MAINSTREAM COMMERCIAL: Dell Pro Plus (ex-Latitude 5000/7000), Lenovo ThinkPad T/X13, HP EliteBook 6-series/8-series, ASUS ExpertBook B5, Acer TravelMate P4/P6, Microsoft Surface Laptop/Pro for Business
 VALUE COMMERCIAL: Dell Pro Base (ex-Latitude 3000), Lenovo ThinkPad E/L, Lenovo ThinkBook, HP ProBook, ASUS ExpertBook B1, Acer TravelMate P2/B series
 CONSUMER: Dell Inspiron/XPS-consumer, Lenovo IdeaPad/Yoga, HP Pavilion/Envy, ASUS Vivobook/Zenbook, Acer Aspire/Swift/Nitro, MSI consumer lines
Same tier + aligned specs = close. One tier apart = partial. Two+ tiers apart = related. Dell naming: Pro Base = value, Pro Plus = mainstream, Pro Premium = flagship.
Lenovo ThinkPad T-series/X13, HP EliteBook 6/8, and Dell Pro Plus all occupy the SAME mainstream commercial tier — same tier + aligned specs = close, do not treat any of them as above or below the others.
ThinkPad T14 and T14S are the same product family at the same mainstream tier — never rate T14S lower than T14 or below mainstream commercial.
FLAGSHIP products (X1 Carbon, X9, EliteBook Ultra, Dragonfly, Dell Pro Premium) against a MAINSTREAM source must be rated "partial" as a premium alternative — never "close", regardless of how well the specs align.
A CONSUMER candidate against a COMMERCIAL source is at most "related". State the tier difference in the reason.
For brands or product lines not listed above, infer the tier from description and price positioning (vPro/3Y-onsite/TPM/"for Business" → commercial; consumer naming → consumer). If the tier cannot be determined, judge on specs alone, rate at most "partial", and state "tier unverified" in the reason.
Ordering rule: output matches close first, then partial, then related. If more candidates qualify than the 12-match cap, drop the weakest partial/related matches first — never drop a close match to make room.
Return at most 12 matches. Each reason must be 15 words or fewer. Respond with raw JSON only — no preamble, no commentary, no markdown fences.`;

/**
 * SIMPLE prompt — intent + latitude, minimal rulebook.
 * Hypothesis: fewer prescriptive rules → more varied, accurate brand spread.
 */
export const SYSTEM_PROMPT_SIMPLE = `You are a product analyst for an IT distributor. \
You will be given a source product and a numbered list of candidate products from other brands, \
each with brand, part number, and description.

Identify which candidates are genuine market alternatives a product manager should consider \
when deciding what to stock. Use your knowledge of specifications, product-line positioning \
(e.g. flagship vs mainstream vs value commercial vs consumer lines), and price positioning. \
Where several brands have genuinely comparable options, include a spread of brands rather than \
many variants from one.

For each match give a similarity of "close", "partial", or "related", and a one-sentence reason \
specific to that candidate — name its actual product line and say what makes it comparable or \
different. Do not reuse the same reason across candidates.

Similarity values: \
"close" = near-identical function, spec class, and product-line tier; \
"partial" = same function but different tier, capacity, or spec class; \
"related" = same broad category but meaningfully different use case or form factor.

Select ONLY from the numbered candidates — never invent products. \
If nothing is genuinely comparable, return an empty list. \
Return JSON only: {"matches":[{"index":<int>,"similarity":"close|partial|related","reason":"<one sentence>"}]}, best first, at most 12. \
No preamble, no commentary, no markdown fences.`;

/** Return the system prompt for the given (or current env-configured) mode. */
export function getSystemPrompt(mode?: PromptMode): string {
  const m = mode ?? getActivePromptMode();
  return m === "strict" ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT_SIMPLE;
}

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
 * @param mode               Prompt mode override — defaults to env var MARKET_PRICE_PROMPT.
 * @returns Parsed LlmJudgeResult with only valid indices retained
 */
export async function callLlmJudge(
  sourceDescription: string,
  candidates: LlmCandidate[],
  maxCandidates = 120,
  classHint?: string | null,
  mode?: PromptMode,
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
    const response = await client.chat.completions.create(
      {
        model: LLM_MODEL,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: getSystemPrompt(mode) },
          { role: "user",   content: userMessage },
        ],
      },
      { signal: controller.signal },
    );
    const choice = response.choices[0];
    stopReason = choice?.finish_reason ?? null;
    rawText = choice?.message?.content ?? "";
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "APIUserAbortError")
    ) {
      throw new LlmUnavailableError("Matching service timed out after 60s");
    }
    throw new LlmUnavailableError(
      `OpenAI API error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  // Detect hard truncation before attempting parse — response was cut mid-JSON
  if (stopReason === "length") {
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

  // Deterministic backstop: sort close → partial → related regardless of model ordering.
  parsed.matches = sortMatchesBySimilarity(parsed.matches);

  return parsed;
}

// ── Similarity sort ────────────────────────────────────────────────────────

export const SIMILARITY_RANK: Record<string, number> = {
  close:   0,
  partial: 1,
  related: 2,
};

/**
 * Sort an array of matches by similarity rank: close first, partial second,
 * related last. Stable within each tier (preserves model ordering).
 */
export function sortMatchesBySimilarity<T extends { similarity: string }>(
  matches: T[],
): T[] {
  return [...matches].sort(
    (a, b) =>
      (SIMILARITY_RANK[a.similarity] ?? 99) -
      (SIMILARITY_RANK[b.similarity] ?? 99),
  );
}
