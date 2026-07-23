// Purpose: See what competing distributors are selling, so Dicker PMs can
// gauge whether to range the stock. Competitor market intelligence, not
// inventory management.

import { useState } from "react";
import {
  useGetMovement,
  useListDistributors,
  useListBrands,
  useCleanupDuplicates,
  getGetMovementQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Wrench,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const PAGE_SIZE = 100;

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-AU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// Minimal SVG sparkline of SOH over the window
function Sparkline({ snapshots }: { snapshots: Array<{ soh?: number | null }> }) {
  const vals = snapshots.map((s) => s.soh ?? 0);
  if (vals.length < 2) return <span className="text-muted-foreground text-[10px]">—</span>;
  const max = Math.max(...vals, 1);
  const w = 56;
  const h = 20;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-muted-foreground"
      />
    </svg>
  );
}

type DickerStatus = "stocked" | "listed" | "not carried";

function DickerBadge({ status }: { status: DickerStatus }) {
  const cls =
    status === "stocked"
      ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
      : status === "listed"
      ? "border-border text-muted-foreground"
      : "border-amber-500 text-amber-700 dark:text-amber-400";
  return (
    <Badge variant="outline" className={`text-[10px] h-4 font-mono uppercase tracking-wide ${cls}`}>
      {status}
    </Badge>
  );
}

type SortCol = "vpn" | "brand" | "desc" | "soh" | "price" | "estWeeklyST" | "estWeeklyRevenue";
const NUM_COLS: SortCol[] = ["soh", "price", "estWeeklyST", "estWeeklyRevenue"];

export default function Movement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [distributorId, setDistributorId] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [sortCol, setSortCol] = useState<SortCol>("estWeeklyRevenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [activeOnly, setActiveOnly] = useState(true);
  const [excludeBundles, setExcludeBundles] = useState(true);
  const [soldOutOnly, setSoldOutOnly] = useState(false);
  const [notCarriedByDicker, setNotCarriedByDicker] = useState(false);

  const { data: distributors = [] } = useListDistributors();
  const { data: brands = [] } = useListBrands();

  const distIdNum = distributorId ? parseInt(distributorId, 10) : undefined;
  const enabled = !!distIdNum;

  const { data, isLoading, isError } = useGetMovement(
    {
      distributorId: distIdNum!,
      ...(brand ? { brand } : {}),
      ...(search ? { search } : {}),
      activeOnly,
      excludeBundles,
      soldOutOnly,
      notCarriedByDicker,
      sortBy: sortCol,
      sortDir,
      limit: PAGE_SIZE,
      offset,
    },
    {
      query: {
        enabled,
        queryKey: getGetMovementQueryKey({
          distributorId: distIdNum!,
          brand: brand || undefined,
          search: search || undefined,
          activeOnly,
          excludeBundles,
          soldOutOnly,
          notCarriedByDicker,
          sortBy: sortCol,
          sortDir,
          limit: PAGE_SIZE,
          offset,
        }),
      },
    },
  );

  const cleanup = useCleanupDuplicates({
    mutation: {
      onSuccess: (result) => {
        toast({
          title: "Cleanup complete",
          description: `${result.rowsDeleted} duplicate rows removed.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetMovementQueryKey() });
      },
      onError: () => toast({ title: "Cleanup failed", variant: "destructive" }),
    },
  });

  const resetPaging = () => setOffset(0);

  const handleSearch = () => { setSearch(searchInput); resetPaging(); };

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(NUM_COLS.includes(col) ? "desc" : "asc");
    }
    resetPaging();
  };

  // Opportunity mode: sold out at competitor AND not carried by Dicker
  const opportunityActive = soldOutOnly && notCarriedByDicker;
  const activateOpportunity = () => {
    setSoldOutOnly(true);
    setNotCarriedByDicker(true);
    resetPaging();
  };
  const clearOpportunity = () => {
    setSoldOutOnly(false);
    setNotCarriedByDicker(false);
    resetPaging();
  };

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const colDefs: { key: SortCol; label: string; right?: boolean; width?: string }[] = [
    { key: "vpn",              label: "VPN",                width: "w-36" },
    { key: "brand",            label: "Brand",              width: "w-24" },
    { key: "desc",             label: "Description" },
    { key: "estWeeklyST",      label: "Est. weekly ST",     right: true, width: "w-28" },
    { key: "price",            label: "Their price",        right: true, width: "w-24" },
    { key: "estWeeklyRevenue", label: "Est. weekly rev.",   right: true, width: "w-28" },
    { key: "soh",              label: "Their SOH",          right: true, width: "w-20" },
  ];

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Stock Movement</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            See what competing distributors are selling, so Dicker PMs can gauge whether to range the stock.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs gap-1.5 text-muted-foreground"
          onClick={() => cleanup.mutate()}
          disabled={cleanup.isPending}
        >
          {cleanup.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Wrench className="h-3 w-3" />
          )}
          Run dedup cleanup
        </Button>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={distributorId} onValueChange={(v) => { setDistributorId(v); resetPaging(); }}>
          <SelectTrigger className="h-7 w-48 text-xs">
            <SelectValue placeholder="Select competitor…" />
          </SelectTrigger>
          <SelectContent>
            {distributors
              .filter((d) => !d.isBaseline)
              .map((d) => (
                <SelectItem key={d.id} value={String(d.id)} className="text-xs">
                  {d.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <Select
          value={brand || "_all"}
          onValueChange={(v) => { setBrand(v === "_all" ? "" : v); resetPaging(); }}
        >
          <SelectTrigger className="h-7 w-36 text-xs">
            <SelectValue placeholder="All brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all" className="text-xs">All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b.id} value={b.canonicalName} className="text-xs">
                {b.canonicalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-1">
          <Input
            className="h-7 w-48 text-xs font-mono"
            placeholder="Search VPN or description…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
          />
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleSearch}>
            Go
          </Button>
          {search && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => { setSearch(""); setSearchInput(""); resetPaging(); }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Filter chips row */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Combined opportunity button — primary use case */}
        <button
          onClick={opportunityActive ? clearOpportunity : activateOpportunity}
          className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-sm border text-xs font-medium transition-colors select-none ${
            opportunityActive
              ? "bg-amber-100 border-amber-500 text-amber-800 dark:bg-amber-950/40 dark:border-amber-500 dark:text-amber-300"
              : "border-border text-muted-foreground hover:bg-secondary/50"
          }`}
        >
          <Zap className="h-3 w-3" />
          Opportunity: sold out + not in Dicker
        </button>

        <span className="text-muted-foreground text-xs">or filter by:</span>

        <button
          onClick={() => { setSoldOutOnly((v) => !v); resetPaging(); }}
          className={`h-7 px-2.5 rounded-sm border text-xs transition-colors select-none ${
            soldOutOnly
              ? "bg-secondary text-secondary-foreground border-border font-medium"
              : "text-muted-foreground border-border hover:bg-secondary/50"
          }`}
        >
          Sold out at competitor
        </button>

        <button
          onClick={() => { setNotCarriedByDicker((v) => !v); resetPaging(); }}
          className={`h-7 px-2.5 rounded-sm border text-xs transition-colors select-none ${
            notCarriedByDicker
              ? "bg-secondary text-secondary-foreground border-border font-medium"
              : "text-muted-foreground border-border hover:bg-secondary/50"
          }`}
        >
          Not carried by Dicker
        </button>

        <button
          onClick={() => { setActiveOnly((v) => !v); resetPaging(); }}
          className={`h-7 px-2.5 rounded-sm border text-xs transition-colors select-none ${
            activeOnly
              ? "bg-secondary text-secondary-foreground border-border font-medium"
              : "text-muted-foreground border-border hover:bg-secondary/50"
          }`}
        >
          Hide inactive lines
        </button>

        <button
          onClick={() => { setExcludeBundles((v) => !v); resetPaging(); }}
          className={`h-7 px-2.5 rounded-sm border text-xs transition-colors select-none ${
            excludeBundles
              ? "bg-secondary text-secondary-foreground border-border font-medium"
              : "text-muted-foreground border-border hover:bg-secondary/50"
          }`}
        >
          Hide bundles/CTO
        </button>
      </div>

      {/* Inference mode / data quality strip */}
      {data && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px] h-5">
            {data.inferenceMode === "soo_aware" ? "SOO-aware" : "SOH-only"}
          </Badge>
          <span className="text-muted-foreground/70">
            Weekly rates normalised to actual data span, not window.
          </span>
          {data.dataQuality.dateRange.from && (
            <span>
              {fmtDate(data.dataQuality.dateRange.from)} — {fmtDate(data.dataQuality.dateRange.to)}
            </span>
          )}
          <span>
            {data.dataQuality.snapshotCount} snapshot
            {data.dataQuality.snapshotCount !== 1 ? "s" : ""} in window
          </span>
          {data.dataQuality.bundlesExcluded > 0 && (
            <span className="text-muted-foreground/60">
              {data.dataQuality.bundlesExcluded.toLocaleString()} bundles/CTO
              {excludeBundles ? " hidden" : " shown"}
            </span>
          )}
          <span className="ml-auto font-mono">{total.toLocaleString()} products</span>
        </div>
      )}

      {/* Empty / loading states */}
      {!enabled && (
        <div className="border rounded-sm bg-card p-8 text-center text-sm text-muted-foreground">
          Select a competitor distributor to load movement data.
        </div>
      )}

      {enabled && isLoading && (
        <div className="border rounded-sm bg-card p-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {isError && (
        <div className="border rounded-sm bg-card p-8 flex items-center justify-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Failed to load movement data.
        </div>
      )}

      {data && products.length === 0 && (
        <div className="border rounded-sm bg-card p-8 text-center space-y-1">
          <p className="text-sm text-muted-foreground">No products match the current filters.</p>
          {data.dataQuality.dateRange.to && (
            <p className="text-xs text-muted-foreground">
              Most recent snapshot:{" "}
              <span className="font-mono">{fmtDate(data.dataQuality.dateRange.to)}</span>
            </p>
          )}
        </div>
      )}

      {/* Main table */}
      {data && products.length > 0 && (
        <div className="border rounded-sm bg-card overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {colDefs.map(({ key, label, right, width }) => {
                  const active = sortCol === key;
                  const Icon = active
                    ? sortDir === "asc"
                      ? ChevronUp
                      : ChevronDown
                    : ChevronsUpDown;
                  return (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className={`px-3 py-2 font-semibold text-muted-foreground select-none cursor-pointer hover:text-foreground transition-colors ${right ? "text-right" : "text-left"} ${width ?? ""} ${active ? "text-foreground" : ""}`}
                    >
                      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
                        {label}
                        <Icon className="h-3 w-3 shrink-0" />
                      </span>
                    </th>
                  );
                })}
                <th className="px-3 py-2 font-semibold text-muted-foreground text-center w-20">
                  Dicker
                </th>
                <th className="px-3 py-2 font-semibold text-muted-foreground text-center w-16">
                  Trend
                </th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => {
                const isEven = i % 2 === 0;
                const isOpportunity = p.soldOut && p.dickerStatus === "not carried";

                // Per-row data quality subtext: shown when we have enough snapshots
                const hasSufficientData =
                  p.snapshotCount != null &&
                  p.daysCovered != null &&
                  p.snapshotCount >= 2 &&
                  p.daysCovered >= 7;

                return (
                  <tr
                    key={p.productId}
                    className={`border-b border-border last:border-0 ${
                      isOpportunity
                        ? "bg-amber-50 dark:bg-amber-950/20"
                        : isEven
                        ? ""
                        : "bg-muted/25"
                    }`}
                  >
                    <td className="px-3 py-1.5 font-mono text-foreground">{p.vpnDisplay}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{p.brand}</td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-xs truncate">
                      {p.description}
                    </td>

                    {/* Est. weekly ST */}
                    <td className="px-3 py-1.5 text-right font-mono">
                      {hasSufficientData ? (
                        <div>
                          <div>{p.estWeeklyST != null ? fmt(p.estWeeklyST) : "—"}</div>
                          <div className="text-[10px] text-muted-foreground/60 font-sans">
                            {p.snapshotCount} snaps / {p.daysCovered}d
                          </div>
                        </div>
                      ) : (
                        <span
                          className="text-muted-foreground/50"
                          title="Insufficient data — need at least 2 snapshots covering 7+ days"
                        >
                          —
                        </span>
                      )}
                    </td>

                    {/* Their price */}
                    <td className="px-3 py-1.5 text-right font-mono">
                      {fmtPrice(p.latestSellPrice)}
                    </td>

                    {/* Est. weekly revenue */}
                    <td className="px-3 py-1.5 text-right font-mono">
                      {p.estWeeklyRevenue != null ? (
                        fmtPrice(p.estWeeklyRevenue)
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>

                    {/* Their SOH */}
                    <td className="px-3 py-1.5 text-right font-mono">
                      {p.soldOut ? (
                        <span className="text-rose-600 dark:text-rose-400 font-medium">
                          SOLD OUT
                        </span>
                      ) : (
                        fmt(p.latestSoh)
                      )}
                    </td>

                    <td className="px-3 py-1.5 text-center">
                      <DickerBadge status={p.dickerStatus as DickerStatus} />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <Sparkline snapshots={p.snapshots} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages} — {total.toLocaleString()} products
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
