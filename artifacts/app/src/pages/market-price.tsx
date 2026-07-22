// Purpose: "Search a SKU and see comparable products from other brands across
// all distributor feeds, with market pricing." Admin-only experimental feature.

import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertCircle, Loader2, Search, Zap } from "lucide-react";

// ── Types (mirroring OpenAPI schemas) ────────────────────────────────────

interface DistributorPrice {
  distributorId: number;
  distributorName: string;
  sellPrice: number | null;
  snapshotDate: string;
}

interface MarketPriceMatch {
  productId: number;
  brand: string;
  vpnDisplay: string;
  description: string;
  similarity: "close" | "partial" | "related";
  reason: string;
  prices: DistributorPrice[];
}

interface MarketPriceSource {
  productId: number | null;
  brand: string | null;
  vpnDisplay: string | null;
  description: string;
  prices: DistributorPrice[];
}

interface MarketPriceResult {
  source: MarketPriceSource;
  matches: MarketPriceMatch[];
  cached: boolean;
  model: string;
  candidatesEvaluated: number;
}

interface ProductSuggestion {
  id: number;
  vpnDisplay: string;
  brand: string;
  description: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

const SIMILARITY_LABEL: Record<string, string> = {
  close: "Close match",
  partial: "Partial match",
  related: "Related",
};

const SIMILARITY_CLASS: Record<string, string> = {
  close: "bg-green-100 text-green-800 border-green-300",
  partial: "bg-yellow-100 text-yellow-800 border-yellow-300",
  related: "bg-slate-100 text-slate-700 border-slate-300",
};

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${url}`, { credentials: "include", ...opts });
  const json = await r.json();
  if (!r.ok) throw new Error(json?.error ?? `HTTP ${r.status}`);
  return json as T;
}

// ── Product search autocomplete ───────────────────────────────────────────

function useProductSearch(query: string) {
  return useQuery<ProductSuggestion[]>({
    queryKey: ["product-search", query],
    queryFn: () =>
      fetchJson<ProductSuggestion[]>(
        `/api/experimental/market-price/search-products?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

// ── Result table ──────────────────────────────────────────────────────────

function DistributorPriceCell({
  prices,
  distributorId,
  cheapestId,
}: {
  prices: DistributorPrice[];
  distributorId: number;
  cheapestId: number | null;
}) {
  const p = prices.find((x) => x.distributorId === distributorId);
  if (!p) return <td className="px-3 py-2 text-muted-foreground font-mono text-xs">—</td>;
  const isCheapest = cheapestId === distributorId && p.sellPrice != null;
  return (
    <td className={`px-3 py-2 font-mono text-xs ${isCheapest ? "font-bold text-green-700" : ""}`}>
      {fmtPrice(p.sellPrice)}
      <div className="text-[10px] text-muted-foreground font-sans">{fmtDate(p.snapshotDate)}</div>
    </td>
  );
}

function ResultsTable({ result }: { result: MarketPriceResult }) {
  // Collect all distributor IDs that appear in any match
  const distIds: number[] = [];
  const distNames = new Map<number, string>();
  for (const m of result.matches) {
    for (const p of m.prices) {
      if (!distNames.has(p.distributorId)) {
        distIds.push(p.distributorId);
        distNames.set(p.distributorId, p.distributorName);
      }
    }
  }

  return (
    <div className="overflow-x-auto border border-border rounded-sm">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-muted/60 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Brand</th>
            <th className="px-3 py-2 text-left font-mono">VPN</th>
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-left">Match</th>
            {distIds.map((id) => (
              <th key={id} className="px-3 py-2 text-right">
                {distNames.get(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.matches.map((m, i) => {
            const cheapestId =
              m.prices
                .filter((p) => p.sellPrice != null)
                .sort((a, b) => (a.sellPrice ?? 0) - (b.sellPrice ?? 0))[0]
                ?.distributorId ?? null;
            return (
              <tr
                key={m.productId}
                className={`border-t border-border ${i % 2 === 1 ? "bg-muted/20" : ""}`}
              >
                <td className="px-3 py-2 font-semibold text-xs">{m.brand}</td>
                <td className="px-3 py-2 font-mono text-xs">{m.vpnDisplay}</td>
                <td className="px-3 py-2 text-xs max-w-xs">
                  <div className="line-clamp-2">{m.description}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 italic">{m.reason}</div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wide ${SIMILARITY_CLASS[m.similarity] ?? ""}`}
                  >
                    {SIMILARITY_LABEL[m.similarity] ?? m.similarity}
                  </span>
                </td>
                {distIds.map((id) => (
                  <DistributorPriceCell
                    key={id}
                    prices={m.prices}
                    distributorId={id}
                    cheapestId={cheapestId}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Source product card ───────────────────────────────────────────────────

function SourceCard({ source }: { source: MarketPriceSource }) {
  return (
    <div className="border border-border rounded-sm bg-card p-3 text-sm mb-4">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        Source product
      </div>
      {source.vpnDisplay ? (
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="font-semibold text-xs">{source.brand}</span>
          <span className="font-mono text-xs">{source.vpnDisplay}</span>
          <span className="text-xs text-muted-foreground">{source.description}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">{source.description}</div>
      )}
      {source.prices.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2">
          {source.prices.map((p) => (
            <div key={p.distributorId} className="text-xs">
              <span className="text-muted-foreground">{p.distributorName}: </span>
              <span className="font-mono">{fmtPrice(p.sellPrice)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SKU search tab ────────────────────────────────────────────────────────

function SkuTab({
  onResult,
  onLoading,
}: {
  onResult: (r: MarketPriceResult | null) => void;
  onLoading: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ProductSuggestion | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  const { data: suggestions = [], isFetching } = useProductSearch(
    selectedProduct ? "" : query,
  );

  const search = useMutation({
    mutationFn: (productId: number) =>
      fetchJson<MarketPriceResult>(`/api/experimental/market-price?productId=${productId}`),
    onMutate: () => onLoading(true),
    onSettled: () => onLoading(false),
    onSuccess: (data) => onResult(data),
    onError: (err: Error) => {
      onResult(null);
      alert(err.message);
    },
  });

  const handleSelect = (p: ProductSuggestion) => {
    setSelectedProduct(p);
    setQuery(`${p.vpnDisplay} — ${p.brand}`);
    setShowDropdown(false);
  };

  const handleSearch = () => {
    if (!selectedProduct) return;
    onResult(null);
    search.mutate(selectedProduct.id);
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <Input
          placeholder="Type a VPN or product name..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedProduct(null);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          className="font-mono text-sm"
        />
        {showDropdown && (suggestions.length > 0 || isFetching) && (
          <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-card border border-border rounded-sm shadow-md max-h-60 overflow-auto">
            {isFetching && (
              <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Searching...
              </div>
            )}
            {suggestions.map((s) => (
              <button
                key={s.id}
                className="w-full text-left px-3 py-2 text-xs hover:bg-muted/60 border-b border-border last:border-0"
                onMouseDown={() => handleSelect(s)}
              >
                <span className="font-mono font-semibold">{s.vpnDisplay}</span>
                <span className="text-muted-foreground ml-2">{s.brand}</span>
                <div className="text-muted-foreground truncate">{s.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <Button
        onClick={handleSearch}
        disabled={!selectedProduct || search.isPending}
        className="gap-2"
      >
        {search.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Analyzing catalogue...
          </>
        ) : (
          <>
            <Search className="h-4 w-4" /> Find equivalents
          </>
        )}
      </Button>
    </div>
  );
}

// ── Spec search tab ───────────────────────────────────────────────────────

function SpecTab({
  onResult,
  onLoading,
}: {
  onResult: (r: MarketPriceResult | null) => void;
  onLoading: (v: boolean) => void;
}) {
  const [specText, setSpecText] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const search = useMutation({
    mutationFn: (body: { specText: string; maxPrice?: number }) =>
      fetchJson<MarketPriceResult>(`/api/experimental/market-price/by-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onMutate: () => onLoading(true),
    onSettled: () => onLoading(false),
    onSuccess: (data) => onResult(data),
    onError: (err: Error) => {
      onResult(null);
      alert(err.message);
    },
  });

  const handleSearch = () => {
    if (!specText.trim()) return;
    onResult(null);
    const body: { specText: string; maxPrice?: number } = { specText };
    const p = parseFloat(maxPrice);
    if (!isNaN(p) && p > 0) body.maxPrice = p;
    search.mutate(body);
  };

  return (
    <div className="space-y-3">
      <Textarea
        placeholder="e.g. 8-port gigabit managed switch with PoE, rack-mountable"
        value={specText}
        onChange={(e) => setSpecText(e.target.value)}
        rows={3}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Max price (AUD)</span>
        <Input
          type="number"
          placeholder="optional"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          className="w-36 font-mono text-sm"
        />
      </div>
      <Button
        onClick={handleSearch}
        disabled={!specText.trim() || search.isPending}
        className="gap-2"
      >
        {search.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Analyzing catalogue...
          </>
        ) : (
          <>
            <Search className="h-4 w-4" /> Find matches
          </>
        )}
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function MarketPrice() {
  const [result, setResult] = useState<MarketPriceResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleResult = useCallback((r: MarketPriceResult | null) => setResult(r), []);
  const handleLoading = useCallback((v: boolean) => setIsLoading(v), []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Market Price</h1>
          <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Experimental
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Search a SKU and see comparable products from other brands across all distributor feeds, with market pricing.
        </p>
      </div>

      {/* Experimental banner */}
      <div className="flex items-start gap-2 border border-yellow-300 bg-yellow-50 rounded-sm px-3 py-2 text-xs text-yellow-800">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Experimental — matches are AI-suggested from catalogue descriptions. Verify specs before quoting.
        </span>
      </div>

      {/* Search */}
      <div className="border border-border rounded-sm bg-card p-4">
        <Tabs defaultValue="sku">
          <TabsList className="mb-3 h-8">
            <TabsTrigger value="sku" className="text-xs h-7">By SKU</TabsTrigger>
            <TabsTrigger value="spec" className="text-xs h-7">By specs</TabsTrigger>
          </TabsList>
          <TabsContent value="sku">
            <SkuTab onResult={handleResult} onLoading={handleLoading} />
          </TabsContent>
          <TabsContent value="spec">
            <SpecTab onResult={handleResult} onLoading={handleLoading} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Analyzing catalogue...</span>
        </div>
      )}

      {/* Results */}
      {!isLoading && result && (
        <div className="space-y-3">
          {/* Meta strip */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {result.cached && (
              <Badge variant="outline" className="text-[10px] font-mono">
                Cached result
              </Badge>
            )}
            <span>{result.candidatesEvaluated} candidates evaluated</span>
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" /> {result.model}
            </span>
          </div>

          <SourceCard source={result.source} />

          {result.matches.length === 0 ? (
            <div className="text-sm text-muted-foreground border border-border rounded-sm px-4 py-8 text-center bg-card">
              No comparable products found in current feeds.
            </div>
          ) : (
            <ResultsTable result={result} />
          )}
        </div>
      )}
    </div>
  );
}
