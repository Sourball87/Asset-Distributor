/**
 * Market Price — cross-brand equivalent finder.
 *
 * Purpose: "Search a SKU and see comparable products from other brands across
 * all distributor feeds, with market pricing."
 *
 * Admin-only. Two endpoints:
 *   GET  /experimental/market-price?productId=...   — by product ID
 *   POST /experimental/market-price/by-spec          — by free-text spec
 *
 * Both share the same pipeline:
 *   1. Candidate retrieval (SQL) — price-band + description keyword overlap, top 120, no bundles
 *   2. 7-day cache check (query_hash) → skip LLM if hit
 *   3. LLM judge (Anthropic claude-sonnet-4-6) — daily cap enforced
 *   4. Response: source summary, matches[], cached bool, model, candidatesEvaluated
 */

import { Router } from "express";
import { z } from "zod";
import { db, marketPriceCacheTable, productsTable } from "@workspace/db";
import { eq, and, sql, gte } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import {
  callLlmJudge,
  incrementAndCheckCap,
  makeQueryHash,
  LlmCapExceededError,
  LlmUnavailableError,
  LLM_MODEL,
  type LlmCandidate,
} from "../lib/market-price-llm";

const router = Router();

// ── Constants ──────────────────────────────────────────────────────────────

const CANDIDATE_LIMIT = 120;
const PRICE_BAND_LOW = 0.4;
const PRICE_BAND_HIGH = 2.5;
const CACHE_DAYS = 7;

// ── Schema helpers ─────────────────────────────────────────────────────────

const GetMarketPriceQuery = z.object({
  productId: z.coerce.number().int().positive(),
});

const GetMarketPriceBySpecBody = z.object({
  specText: z.string().min(3),
  maxPrice: z.coerce.number().positive().nullable().optional(),
});

// ── Shared types ───────────────────────────────────────────────────────────

interface DistributorPrice {
  distributorId: number;
  distributorName: string;
  sellPrice: number | null;
  snapshotDate: string;
}

interface MatchRow {
  productId: number;
  brand: string;
  vpnDisplay: string;
  description: string;
  similarity: "close" | "partial" | "related";
  reason: string;
  prices: DistributorPrice[];
}

interface MarketPriceResponse {
  source: {
    productId: number | null;
    brand: string | null;
    vpnDisplay: string | null;
    description: string;
    prices: DistributorPrice[];
  };
  matches: MatchRow[];
  cached: boolean;
  model: string;
  candidatesEvaluated: number;
}

// ── Helper: latest price per distributor for a set of product IDs ──────────

async function getLatestPricesForProducts(
  productIds: number[],
): Promise<Map<number, DistributorPrice[]>> {
  if (productIds.length === 0) return new Map();

  const rows = await db.execute<{
    product_id: number;
    distributor_id: number;
    distributor_name: string;
    sell_price: string | null;
    snapshot_date: string;
  }>(sql`
    SELECT DISTINCT ON (ss.product_id, ss.distributor_id)
      ss.product_id,
      ss.distributor_id,
      d.name AS distributor_name,
      ss.sell_price,
      ss.snapshot_date
    FROM stock_snapshots ss
    JOIN distributors d ON d.id = ss.distributor_id
    WHERE ss.product_id = ANY(${sql.raw(`ARRAY[${productIds.join(",")}]::int[]`)})
    ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC
  `);

  const map = new Map<number, DistributorPrice[]>();
  for (const r of rows.rows) {
    const pid = Number(r.product_id);
    const entry: DistributorPrice = {
      distributorId: Number(r.distributor_id),
      distributorName: r.distributor_name,
      sellPrice: r.sell_price != null ? parseFloat(r.sell_price) : null,
      snapshotDate: r.snapshot_date,
    };
    const arr = map.get(pid) ?? [];
    arr.push(entry);
    map.set(pid, arr);
  }
  return map;
}

// ── Helper: candidate retrieval by price band + keyword overlap ────────────

async function getCandidates(opts: {
  sourceBrand: string;
  sourceDescription: string;
  refPrice: number; // reference price for band calculation
  maxPrice?: number | null;
  excludeProductId?: number;
}): Promise<Array<{ productId: number; brand: string; vpnDisplay: string; description: string; latestPrice: number | null }>> {
  const priceLow = opts.refPrice * PRICE_BAND_LOW;
  const priceHigh = opts.refPrice * PRICE_BAND_HIGH;

  // Build keyword array from source description for overlap scoring.
  // Simple word tokenisation — strip punctuation, lower, unique words ≥4 chars.
  const keywords = [...new Set(
    opts.sourceDescription
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  )].slice(0, 30);

  const kwArray = keywords.length > 0
    ? sql.raw(`ARRAY[${keywords.map((k) => `'${k.replace(/'/g, "''")}'`).join(",")}]::text[]`)
    : sql.raw(`ARRAY[]::text[]`);

  const bundleExclude = sql.raw(`NOT COALESCE(
    CASE
      WHEN latest.sku_type IS NOT NULL AND latest.sku_type != ''
      THEN latest.sku_type = 'BundledItem'
      ELSE p.vpn_display ILIKE 'CTO%' OR STRPOS(p.vpn_display, '_') > 0
    END,
    FALSE
  )`);

  const excludeId = opts.excludeProductId ?? -1;

  const rows = await db.execute<{
    product_id: number;
    brand: string;
    vpn_display: string;
    description: string;
    latest_price: string | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ss.product_id)
        ss.product_id,
        ss.sell_price,
        ss.sku_type
      FROM stock_snapshots ss
      ORDER BY ss.product_id, ss.snapshot_date DESC
    )
    SELECT
      p.id AS product_id,
      p.brand,
      p.vpn_display,
      p.description,
      latest.sell_price AS latest_price,
      (
        SELECT COUNT(*)
        FROM UNNEST(${kwArray}) AS kw
        WHERE LOWER(p.description) LIKE '%' || kw || '%'
      ) AS keyword_overlap
    FROM products p
    JOIN latest ON latest.product_id = p.id
    WHERE p.brand != ${opts.sourceBrand}
      AND p.id != ${excludeId}
      AND latest.sell_price IS NOT NULL
      AND latest.sell_price::numeric BETWEEN ${priceLow} AND ${priceHigh}
      ${opts.maxPrice != null ? sql`AND latest.sell_price::numeric <= ${opts.maxPrice}` : sql``}
      AND ${bundleExclude}
      AND p.description != ''
    ORDER BY keyword_overlap DESC, latest.sell_price::numeric ASC
    LIMIT ${CANDIDATE_LIMIT}
  `);

  return rows.rows.map((r) => ({
    productId: Number(r.product_id),
    brand: r.brand,
    vpnDisplay: r.vpn_display,
    description: r.description,
    latestPrice: r.latest_price != null ? parseFloat(r.latest_price) : null,
  }));
}

// ── Helper: check + retrieve from 7-day cache ─────────────────────────────

async function getCached(queryHash: string): Promise<MarketPriceResponse | null> {
  const cutoff = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  const [row] = await db
    .select()
    .from(marketPriceCacheTable)
    .where(
      and(
        eq(marketPriceCacheTable.queryHash, queryHash),
        gte(marketPriceCacheTable.createdAt, new Date(cutoff)),
      ),
    )
    .limit(1);

  if (!row) return null;
  return row.responseJson as MarketPriceResponse;
}

async function putCache(opts: {
  productId: number | null;
  queryHash: string;
  requestSummary: string;
  response: MarketPriceResponse;
}): Promise<void> {
  await db
    .insert(marketPriceCacheTable)
    .values({
      productId: opts.productId,
      queryHash: opts.queryHash,
      requestSummary: opts.requestSummary,
      responseJson: opts.response as unknown as Record<string, unknown>,
      model: LLM_MODEL,
    })
    .onConflictDoUpdate({
      target: marketPriceCacheTable.queryHash,
      set: {
        responseJson: opts.response as unknown as Record<string, unknown>,
        model: LLM_MODEL,
        createdAt: new Date(),
      },
    });
}

// ── Core pipeline ──────────────────────────────────────────────────────────

async function runPipeline(opts: {
  productId: number | null;
  sourceBrand: string | null;
  sourceDescription: string;
  sourceVpnDisplay: string | null;
  sourcePrices: DistributorPrice[];
  refPrice: number;
  maxPrice?: number | null;
  queryHash: string;
  requestSummary: string;
}): Promise<MarketPriceResponse> {
  // Cache check
  const cached = await getCached(opts.queryHash);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Candidate retrieval
  const candidates = await getCandidates({
    sourceBrand: opts.sourceBrand ?? "__NONE__",
    sourceDescription: opts.sourceDescription,
    refPrice: opts.refPrice,
    maxPrice: opts.maxPrice,
    excludeProductId: opts.productId ?? undefined,
  });

  if (candidates.length === 0) {
    const empty: MarketPriceResponse = {
      source: {
        productId: opts.productId,
        brand: opts.sourceBrand,
        vpnDisplay: opts.sourceVpnDisplay,
        description: opts.sourceDescription,
        prices: opts.sourcePrices,
      },
      matches: [],
      cached: false,
      model: LLM_MODEL,
      candidatesEvaluated: 0,
    };
    await putCache({ productId: opts.productId, queryHash: opts.queryHash, requestSummary: opts.requestSummary, response: empty });
    return empty;
  }

  // Daily cap + LLM call
  await incrementAndCheckCap();

  const llmCandidates: LlmCandidate[] = candidates.map((c, i) => ({
    index: i,
    description: c.description,
    brand: c.brand,
    vpnDisplay: c.vpnDisplay,
  }));

  const judgeResult = await callLlmJudge(opts.sourceDescription, llmCandidates);

  // Map indices back to real products
  const priceMap = await getLatestPricesForProducts(candidates.map((c) => c.productId));

  const matches: MatchRow[] = judgeResult.matches
    .filter((m) => m.index >= 0 && m.index < candidates.length)
    .map((m) => {
      const c = candidates[m.index]!;
      return {
        productId: c.productId,
        brand: c.brand,
        vpnDisplay: c.vpnDisplay,
        description: c.description,
        similarity: m.similarity,
        reason: m.reason,
        prices: priceMap.get(c.productId) ?? [],
      };
    });

  const result: MarketPriceResponse = {
    source: {
      productId: opts.productId,
      brand: opts.sourceBrand,
      vpnDisplay: opts.sourceVpnDisplay,
      description: opts.sourceDescription,
      prices: opts.sourcePrices,
    },
    matches,
    cached: false,
    model: LLM_MODEL,
    candidatesEvaluated: candidates.length,
  };

  await putCache({ productId: opts.productId, queryHash: opts.queryHash, requestSummary: opts.requestSummary, response: result });
  return result;
}

// ── GET /experimental/market-price/search-products ───────────────────────
// Autocomplete: returns up to 20 products matching a VPN or description query.

router.get("/experimental/market-price/search-products", requireAdmin, async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json([]);
    return;
  }

  const rows = await db.execute<{
    id: number;
    vpn_display: string;
    brand: string;
    description: string;
  }>(sql`
    SELECT id, vpn_display, brand, description
    FROM products
    WHERE vpn_display ILIKE ${"%" + q + "%"}
       OR description ILIKE ${"%" + q + "%"}
    ORDER BY
      CASE WHEN vpn_display ILIKE ${q + "%"} THEN 0 ELSE 1 END,
      vpn_display
    LIMIT 20
  `);

  res.json(rows.rows.map((r) => ({
    id: r.id,
    vpnDisplay: r.vpn_display,
    brand: r.brand,
    description: r.description,
  })));
});

// ── GET /experimental/market-price ────────────────────────────────────────

router.get("/experimental/market-price", requireAdmin, async (req, res): Promise<void> => {
  const parsed = GetMarketPriceQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "productId (integer) is required" });
    return;
  }

  const { productId } = parsed.data;

  // Load source product
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, productId))
    .limit(1);

  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const sourcePrices = (await getLatestPricesForProducts([productId])).get(productId) ?? [];
  const refPrice = sourcePrices.find((p) => p.sellPrice != null)?.sellPrice ?? 0;

  if (refPrice === 0) {
    res.status(422).json({ error: "Source product has no current sell price — cannot determine price band" });
    return;
  }

  const queryHash = makeQueryHash(`product:${productId}:${product.description}`);

  try {
    const result = await runPipeline({
      productId,
      sourceBrand: product.brand,
      sourceDescription: product.description,
      sourceVpnDisplay: product.vpnDisplay,
      sourcePrices,
      refPrice,
      queryHash,
      requestSummary: `Product ${product.vpnDisplay} (${product.brand})`,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LlmCapExceededError) {
      res.status(429).json({ error: err.message });
    } else if (err instanceof LlmUnavailableError) {
      req.log.error({ err }, "market-price LLM unavailable");
      res.status(502).json({ error: err.message });
    } else {
      req.log.error({ err }, "market-price unexpected error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ── POST /experimental/market-price/by-spec ───────────────────────────────

router.post("/experimental/market-price/by-spec", requireAdmin, async (req, res): Promise<void> => {
  const parsed = GetMarketPriceBySpecBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "specText (string, min 3 chars) is required" });
    return;
  }

  const { specText, maxPrice } = parsed.data;

  // Use the maxPrice as the refPrice if provided; otherwise derive a mid-range
  // from it so the band calculation makes sense. Fall back to refPrice=1000 (wide band).
  const refPrice = maxPrice != null ? maxPrice : 1000;

  const queryHash = makeQueryHash(`spec:${specText}:maxPrice=${maxPrice ?? "none"}`);

  try {
    const result = await runPipeline({
      productId: null,
      sourceBrand: null,
      sourceDescription: specText,
      sourceVpnDisplay: null,
      sourcePrices: [],
      refPrice,
      maxPrice,
      queryHash,
      requestSummary: `Spec: "${specText.slice(0, 80)}"`,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LlmCapExceededError) {
      res.status(429).json({ error: err.message });
    } else if (err instanceof LlmUnavailableError) {
      req.log.error({ err }, "market-price/by-spec LLM unavailable");
      res.status(502).json({ error: err.message });
    } else {
      req.log.error({ err }, "market-price/by-spec unexpected error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
