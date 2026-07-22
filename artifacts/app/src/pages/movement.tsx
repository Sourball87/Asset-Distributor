import { useState } from "react";
import {
  useGetMovement,
  useListDistributors,
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
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const PAGE_SIZE = 100;

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-AU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Movement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [distributorId, setDistributorId] = useState<string>("");
  const [days, setDays] = useState<string>("14");
  const [brand, setBrand] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [offset, setOffset] = useState(0);

  const { data: distributors = [] } = useListDistributors();

  const distIdNum = distributorId ? parseInt(distributorId, 10) : undefined;
  const enabled = !!distIdNum;

  const { data, isLoading, isError } = useGetMovement(
    {
      distributorId: distIdNum!,
      days: parseInt(days, 10),
      ...(brand ? { brand } : {}),
      ...(search ? { search } : {}),
      limit: PAGE_SIZE,
      offset,
    },
    { query: { enabled, queryKey: getGetMovementQueryKey({ distributorId: distIdNum!, days: parseInt(days, 10), brand: brand || undefined, search: search || undefined, limit: PAGE_SIZE, offset }) } },
  );

  const cleanup = useCleanupDuplicates({
    mutation: {
      onSuccess: (result) => {
        toast({
          title: "Cleanup complete",
          description: `${result.rowsDeleted} duplicate rows removed. Remaining: ${result.remainingDuplicateGroups.exactIdentical} identical, ${result.remainingDuplicateGroups.differing} differing.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetMovementQueryKey() });
      },
      onError: () => {
        toast({ title: "Cleanup failed", variant: "destructive" });
      },
    },
  });

  const handleSearch = () => {
    setSearch(searchInput);
    setOffset(0);
  };

  const handleDistributor = (v: string) => {
    setDistributorId(v);
    setOffset(0);
  };

  const brands = Array.from(new Set(distributors.map(() => ""))).filter(Boolean);

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const showSoo = data?.inferenceMode === "soo_aware";

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Stock Movement</h1>
          <p className="text-xs text-muted-foreground mt-0.5">SOH delta per distributor over a look-back window</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs gap-1.5 text-muted-foreground"
          onClick={() => cleanup.mutate()}
          disabled={cleanup.isPending}
        >
          {cleanup.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
          Run dedup cleanup
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={distributorId} onValueChange={handleDistributor}>
          <SelectTrigger className="h-7 w-48 text-xs">
            <SelectValue placeholder="Select distributor…" />
          </SelectTrigger>
          <SelectContent>
            {distributors.map((d) => (
              <SelectItem key={d.id} value={String(d.id)} className="text-xs">{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={days} onValueChange={(v) => { setDays(v); setOffset(0); }}>
          <SelectTrigger className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7" className="text-xs">7 days</SelectItem>
            <SelectItem value="14" className="text-xs">14 days</SelectItem>
            <SelectItem value="30" className="text-xs">30 days</SelectItem>
            <SelectItem value="60" className="text-xs">60 days</SelectItem>
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
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleSearch}>Go</Button>
          {search && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setSearch(""); setSearchInput(""); setOffset(0); }}>Clear</Button>
          )}
        </div>
      </div>

      {/* Data quality / inference mode strip */}
      {data && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px] h-5">
            {data.inferenceMode === "soo_aware" ? "SOO-aware" : "SOH-only"}
          </Badge>
          <span>{data.dataQuality.snapshotCount} snapshot date{data.dataQuality.snapshotCount !== 1 ? "s" : ""} in window</span>
          {data.dataQuality.dateRange.from && (
            <span>{fmtDate(data.dataQuality.dateRange.from)} — {fmtDate(data.dataQuality.dateRange.to)}</span>
          )}
          <span className="ml-auto font-mono">{total.toLocaleString()} products</span>
        </div>
      )}

      {/* States */}
      {!enabled && (
        <div className="border rounded-sm bg-card p-8 text-center text-sm text-muted-foreground">
          Select a distributor to load movement data.
        </div>
      )}

      {enabled && isLoading && (
        <div className="border rounded-sm bg-card p-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {enabled && isError && (
        <div className="border rounded-sm bg-card p-8 flex items-center justify-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> Failed to load movement data.
        </div>
      )}

      {/* Table */}
      {data && products.length === 0 && (
        <div className="border rounded-sm bg-card p-8 text-center text-sm text-muted-foreground">
          No products found in this window.
        </div>
      )}

      {data && products.length > 0 && (
        <div className="border rounded-sm bg-card overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground w-32">VPN</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground w-24">Brand</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Description</th>
                <th className="text-right px-3 py-2 font-semibold text-muted-foreground w-20">SOH</th>
                {showSoo && <th className="text-right px-3 py-2 font-semibold text-muted-foreground w-20">SOO</th>}
                <th className="text-right px-3 py-2 font-semibold text-muted-foreground w-24">Price</th>
                <th className="text-right px-3 py-2 font-semibold text-muted-foreground w-32">Movement</th>
                <th className="text-right px-3 py-2 font-semibold text-muted-foreground w-32">Price spread</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => {
                const isEven = i % 2 === 0;
                const movColor =
                  p.isNew ? "text-blue-600 dark:text-blue-400"
                  : p.movement == null ? "text-muted-foreground"
                  : p.movement > 0 ? "text-green-700 dark:text-green-400"
                  : p.movement < 0 ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground";

                const movLabel =
                  p.isNew ? "NEW"
                  : p.movement == null ? "—"
                  : p.movement > 0 ? `+${fmt(p.movement)}`
                  : fmt(p.movement);

                const movSince = !p.isNew && p.movementSinceDate
                  ? `since ${fmtDate(p.movementSinceDate)}`
                  : "";

                return (
                  <tr key={p.productId} className={`border-b border-border last:border-0 ${isEven ? "" : "bg-muted/25"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{p.vpnDisplay}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{p.brand}</td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-xs truncate">{p.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt(p.latestSoh)}</td>
                    {showSoo && <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmt(p.latestSoo)}</td>}
                    <td className="px-3 py-1.5 text-right font-mono">{fmtPrice(p.latestSellPrice)}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${movColor}`}>
                      <span className="font-medium">{movLabel}</span>
                      {movSince && <span className="block text-[10px] font-sans text-muted-foreground">{movSince}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {p.priceSpreadFlag ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {fmtPrice(p.priceSpreadFlag.minPrice)} / {fmtPrice(p.priceSpreadFlag.maxPrice)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
          <span>Page {currentPage} of {totalPages} — {total.toLocaleString()} products</span>
          <div className="flex gap-1">
            <Button
              variant="outline" size="sm" className="h-7 w-7 p-0"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline" size="sm" className="h-7 w-7 p-0"
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
