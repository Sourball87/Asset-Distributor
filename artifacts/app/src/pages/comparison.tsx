import { useState, useMemo, useEffect } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz } from "ag-grid-community";
import type { ColDef, ColGroupDef, RowClassParams, ValueFormatterParams, CellClassParams, CellStyle, ITooltipParams } from "ag-grid-community";
import {
  useGetComparison,
  useListBrands,
  type ComparisonRow,
  type ComparisonResult,
  type Distributor,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, AlertTriangle, FileDown, ChevronDown, X } from "lucide-react";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({
  rowHeight: 26,
  headerHeight: 28,
  fontSize: 12,
  fontFamily: "var(--font-sans, ui-sans-serif, system-ui)",
  headerFontSize: 11,
  headerFontWeight: 600,
  oddRowBackgroundColor: "hsl(var(--muted) / 0.35)",
  rowHoverColor: "hsl(var(--primary) / 0.06)",
  borderColor: "hsl(var(--border))",
  headerBackgroundColor: "hsl(var(--card))",
  backgroundColor: "hsl(var(--background))",
  foregroundColor: "hsl(var(--foreground))",
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${Math.round(v).toLocaleString("en-AU")}`;
}

function fmtSoh(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-AU");
}

function fmtDelta(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.round(Math.abs(v)).toLocaleString("en-AU");
  return v < 0 ? `-$${abs}` : `+$${abs}`;
}

function fmtDeltaPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
}

/** Format an Ingram weekly sales estimate as "~N.N / wk" */
function fmtWeeklySales(v: number | null | undefined): string {
  if (v == null) return "—";
  return `~${v.toFixed(1)} / wk`;
}

/** Format an ISO date string (YYYY-MM-DD) as DD.MM.YYYY */
function fmtDateDDMMYYYY(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// ---------------------------------------------------------------------------
// Row flattening
// ---------------------------------------------------------------------------

type FlatRow = {
  productId: number;
  vpnDisplay: string;
  brand: string;
  description: string;
  dickerIsMostExpensive: boolean;
  cheapestCompetitorId: number | null;
  /** True when every distributor's snapshot is stale (none are current). */
  allStale: boolean;
  /** Ingram Micro estimated weekly unit sell-through, or null if insufficient data. */
  ingramWeeklySales: number | null;
  [key: string]: unknown;
};

function flattenRows(rows: ComparisonRow[]): FlatRow[] {
  return rows.map((row) => {
    const flat: FlatRow = {
      productId: row.productId,
      vpnDisplay: row.vpnDisplay,
      brand: row.brand,
      description: row.description,
      dickerIsMostExpensive: row.dickerIsMostExpensive,
      cheapestCompetitorId: row.cheapestCompetitorId ?? null,
      allStale: row.distributors.every((d) => !d.isCurrent),
      ingramWeeklySales: row.ingramWeeklySales ?? null,
    };
    for (const d of row.distributors) {
      flat[`d${d.distributorId}_price`]        = d.sellPrice ?? null;
      flat[`d${d.distributorId}_soh`]          = d.soh ?? null;
      flat[`d${d.distributorId}_delta`]        = d.priceDelta ?? null;
      flat[`d${d.distributorId}_deltaPct`]     = d.priceDeltaPct ?? null;
      flat[`d${d.distributorId}_cheapest`]     = row.cheapestCompetitorId === d.distributorId;
      flat[`d${d.distributorId}_isCurrent`]    = d.isCurrent ?? false;
      flat[`d${d.distributorId}_snapshotDate`] = d.snapshotDate ?? null;
    }
    return flat;
  });
}

// ---------------------------------------------------------------------------
// Staleness helpers (used inside column definitions)
// ---------------------------------------------------------------------------

function getIsCurrent(data: FlatRow | undefined, distId: number): boolean {
  return !!(data?.[`d${distId}_isCurrent`] as boolean | undefined);
}

function getSnapshotDate(data: FlatRow | undefined, distId: number): string | null {
  return (data?.[`d${distId}_snapshotDate`] as string | null | undefined) ?? null;
}

function staleTooltip(data: FlatRow | undefined, distId: number): string | null {
  if (getIsCurrent(data, distId)) return null;
  const d = getSnapshotDate(data, distId);
  return d ? `Last seen ${fmtDateDDMMYYYY(d)}` : "No data";
}

// ---------------------------------------------------------------------------
// Column builder
// ---------------------------------------------------------------------------

const MONO: CellStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };
const STALE_MONO: CellStyle = { ...MONO, color: "#9ca3af" };

function buildColumns(distributors: Distributor[]): (ColDef | ColGroupDef)[] {
  const leftPinned: ColDef[] = [
    {
      field: "vpnDisplay",
      headerName: "VPN",
      pinned: "left",
      width: 150,
      cellStyle: MONO,
    },
    {
      field: "brand",
      headerName: "Brand",
      pinned: "left",
      width: 90,
    },
    {
      field: "description",
      headerName: "Description",
      pinned: "left",
      width: 260,
      minWidth: 160,
      maxWidth: 360,
      tooltipField: "description",
    },
  ];

  const distGroups: ColGroupDef[] = distributors.map((d) => {
    const priceCol: ColDef = {
      headerName: "Price",
      colId: `d${d.id}_price`,
      field: `d${d.id}_price`,
      width: 88,
      type: "rightAligned",
      cellClass: "dist-group-start",
      headerClass: "dist-group-start",
      cellStyle: (p: CellClassParams): CellStyle => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return STALE_MONO;
        return MONO;
      },
      valueFormatter: (p: ValueFormatterParams) => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return "—";
        return fmtPrice(p.value as number | null);
      },
      tooltipValueGetter: (p: ITooltipParams) =>
        staleTooltip(p.data as FlatRow, d.id),
      comparator: (a: number | null, b: number | null) => (a ?? -Infinity) - (b ?? -Infinity),
    };

    const sohCol: ColDef = {
      headerName: "SOH",
      colId: `d${d.id}_soh`,
      field: `d${d.id}_soh`,
      width: 68,
      type: "rightAligned",
      cellStyle: (p: CellClassParams): CellStyle => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return STALE_MONO;
        return MONO;
      },
      valueFormatter: (p: ValueFormatterParams) => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return "—";
        return fmtSoh(p.value as number | null);
      },
      tooltipValueGetter: (p: ITooltipParams) =>
        staleTooltip(p.data as FlatRow, d.id),
      comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
    };

    if (d.isBaseline) {
      priceCol.pinned = "left";
      sohCol.pinned   = "left";
      return {
        headerName: d.name + " ★",
        children: [priceCol, sohCol],
      };
    }

    const deltaCol: ColDef = {
      headerName: "$ Diff",
      colId: `d${d.id}_delta`,
      field: `d${d.id}_delta`,
      width: 88,
      type: "rightAligned",
      cellStyle: (p: CellClassParams): CellStyle => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return STALE_MONO;
        const v = p.value as number | null;
        if (v == null) return MONO;
        return { ...MONO, color: v < 0 ? "#dc2626" : "#16a34a", fontWeight: "600" } as CellStyle;
      },
      valueFormatter: (p: ValueFormatterParams) => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return "—";
        return fmtDelta(p.value as number | null);
      },
      tooltipValueGetter: (p: ITooltipParams) =>
        staleTooltip(p.data as FlatRow, d.id),
      comparator: (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0),
    };

    const deltaPctCol: ColDef = {
      headerName: "% Diff",
      colId: `d${d.id}_deltaPct`,
      field: `d${d.id}_deltaPct`,
      width: 66,
      type: "rightAligned",
      cellStyle: (p: CellClassParams): CellStyle => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return STALE_MONO;
        const v = p.value as number | null;
        if (v == null) return MONO;
        return { ...MONO, color: v < 0 ? "#dc2626" : "#16a34a" } as CellStyle;
      },
      valueFormatter: (p: ValueFormatterParams) => {
        if (!getIsCurrent(p.data as FlatRow, d.id)) return "—";
        return fmtDeltaPct(p.value as number | null);
      },
      tooltipValueGetter: (p: ITooltipParams) =>
        staleTooltip(p.data as FlatRow, d.id),
      comparator: (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0),
    };

    const children: ColDef[] = [priceCol, sohCol, deltaCol, deltaPctCol];

    // For Ingram Micro, append the weekly sell-through estimate column.
    if (d.name.toLowerCase().includes("ingram")) {
      children.push({
        field: "ingramWeeklySales",
        headerName: "Wkly Sales",
        headerTooltip: "Ingram Micro estimated weekly unit sell-through (last 30 days)",
        width: 96,
        type: "rightAligned",
        cellStyle: (p: CellClassParams): CellStyle => {
          if (!getIsCurrent(p.data as FlatRow, d.id)) return STALE_MONO;
          return { ...MONO, color: "#6366f1" };
        },
        valueFormatter: (p: ValueFormatterParams) => {
          if (!getIsCurrent(p.data as FlatRow, d.id)) return "—";
          return fmtWeeklySales(p.value as number | null);
        },
        comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
      });
    }

    return {
      headerName: d.name,
      children,
    };
  });

  return [...leftPinned, ...distGroups];
}

// ---------------------------------------------------------------------------
// Single-SKU stacked view
// ---------------------------------------------------------------------------

interface SingleSkuViewProps {
  row: FlatRow;
  distributors: Distributor[];
}

function SingleSkuView({ row, distributors }: SingleSkuViewProps) {
  const baseline = distributors.find((d) => d.isBaseline);
  const n = distributors.length;

  return (
    <div className="border rounded-sm overflow-hidden">
      <table className="text-xs border-collapse">
        <thead>
          <tr className="bg-card border-b">
            <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-32">VPN</th>
            <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-20">Brand</th>
            <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-72">Description</th>
            <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-28">Distributor</th>
            <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-24">Price (ex)</th>
            <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-16">SOH</th>
            <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-20">Δ$</th>
            <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground text-[11px] w-16">Δ%</th>
            <th className="text-right px-3 py-1.5 font-semibold text-[11px] w-24" style={{ color: "#6366f1" }} title="Ingram Micro estimated weekly unit sell-through (last 30 days)">Wkly Sales</th>
          </tr>
        </thead>
        <tbody>
          {distributors.map((d, i) => {
            const isCurrent = getIsCurrent(row, d.id);
            const price     = row[`d${d.id}_price`]    as number | null;
            const soh       = row[`d${d.id}_soh`]      as number | null;
            const delta     = row[`d${d.id}_delta`]    as number | null;
            const deltaPct  = row[`d${d.id}_deltaPct`] as number | null;
            const snapDate  = getSnapshotDate(row, d.id);
            const staleHint = !isCurrent ? (snapDate ? `Last seen ${fmtDateDDMMYYYY(snapDate)}` : "No data") : null;
            const cheapest  = !d.isBaseline && !!(row[`d${d.id}_cheapest`] as boolean);
            const rowBg     = cheapest ? "bg-green-50" : row.dickerIsMostExpensive && d.isBaseline ? "bg-red-50" : i % 2 !== 0 ? "bg-muted/20" : "";

            return (
              <tr key={d.id} className={`border-b last:border-0 ${rowBg}`}>
                {/* VPN + Brand + Description span all distributor rows via rowSpan */}
                {i === 0 && (
                  <>
                    <td rowSpan={n} className="px-3 py-1.5 align-top font-mono text-[11px] font-medium border-r border-border/50 whitespace-nowrap">
                      {row.vpnDisplay}
                    </td>
                    <td rowSpan={n} className="px-3 py-1.5 align-top text-[11px] border-r border-border/50 whitespace-nowrap">
                      {row.brand}
                    </td>
                    <td rowSpan={n} className="px-3 py-1.5 align-top text-[11px] text-muted-foreground border-r border-border/50 max-w-[288px] break-words">
                      {row.description}
                    </td>
                  </>
                )}

                {/* Distributor name */}
                <td className="px-3 py-1.5 text-[11px] font-medium border-r border-border/50">
                  <span className={isCurrent ? "" : "text-muted-foreground/50"}>
                    {d.name}{d.isBaseline ? " ★" : ""}
                  </span>
                  {baseline && d.id === baseline.id && row.dickerIsMostExpensive && (
                    <span className="ml-1 text-[10px] text-red-500 font-semibold">▲</span>
                  )}
                  {cheapest && (
                    <span className="ml-1 text-[10px] text-green-600 font-semibold">✓</span>
                  )}
                  {staleHint && (
                    <span className="block text-[10px] text-muted-foreground/50 font-normal">{staleHint}</span>
                  )}
                </td>

                {/* Price */}
                <td className={`px-3 py-1.5 text-right font-mono text-[11px] ${isCurrent ? "" : "text-muted-foreground/40"}`}>
                  {isCurrent ? fmtPrice(price) : "—"}
                </td>

                {/* SOH */}
                <td className={`px-3 py-1.5 text-right font-mono text-[11px] ${isCurrent ? "" : "text-muted-foreground/40"}`}>
                  {isCurrent ? fmtSoh(soh) : "—"}
                </td>

                {/* Δ$ */}
                <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                  {d.isBaseline || !isCurrent ? (
                    <span className="text-muted-foreground/40">—</span>
                  ) : (
                    <span style={{ color: delta == null ? undefined : delta < 0 ? "#dc2626" : "#16a34a", fontWeight: delta != null ? 600 : undefined }}>
                      {fmtDelta(delta)}
                    </span>
                  )}
                </td>

                {/* Δ% */}
                <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                  {d.isBaseline || !isCurrent ? (
                    <span className="text-muted-foreground/40">—</span>
                  ) : (
                    <span style={{ color: deltaPct == null ? undefined : deltaPct < 0 ? "#dc2626" : "#16a34a" }}>
                      {fmtDeltaPct(deltaPct)}
                    </span>
                  )}
                </td>

                {/* Wkly Sales — value shown on Ingram's row only */}
                <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                  {d.name.toLowerCase().includes("ingram") ? (
                    <span style={{ color: row.ingramWeeklySales != null ? "#6366f1" : undefined }}>
                      {fmtWeeklySales(row.ingramWeeklySales)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/20">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Comparison() {
  const [brandFilter, setBrandFilter]       = useState<string>("all");
  const [onlyMostExpensive, setOnlyMostExpensive] = useState(false);
  const [showStaleRows, setShowStaleRows]   = useState(false);
  const [partialMatch, setPartialMatch]     = useState(false);
  const [searchInput, setSearchInput]       = useState("");
  const [searchParam, setSearchParam]       = useState("");
  const [exporting, setExporting]           = useState(false);
  const [selectedDistIds, setSelectedDistIds] = useState<Set<number>>(new Set());

  const { data: brandsData } = useListBrands();
  const brands = (brandsData ?? []).filter((b) => !b.referenceOnly);

  // Debounce search: only send to API 400 ms after the user stops typing
  useEffect(() => {
    const t = setTimeout(() => setSearchParam(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (brandFilter && brandFilter !== "all") p.brand = brandFilter;
    if (searchParam) p.search = searchParam;
    if (showStaleRows) p.showStale = "true";
    if (searchParam && partialMatch) p.partialMatch = "true";
    return Object.keys(p).length ? p : undefined;
  }, [brandFilter, searchParam, showStaleRows, partialMatch]);

  const [dismissedWarnings, setDismissedWarnings] = useState<Set<number>>(new Set());

  const { data, isLoading, isError } = useGetComparison(queryParams, {
    query: { staleTime: 60_000, queryKey: ["comparison", queryParams] },
  });

  // Clear dismissed warnings when data refreshes (new distributors may have different state)
  useEffect(() => {
    setDismissedWarnings(new Set());
  }, [data]);

  const freshnessWarnings = useMemo(
    () => ((data as ComparisonResult | undefined)?.freshnessWarnings ?? []).filter(
      (w) => !dismissedWarnings.has(w.distributorId),
    ),
    [data, dismissedWarnings],
  );

  const distributors: Distributor[] = useMemo(() => data?.distributors ?? [], [data]);

  // Initialise selection to all distributors when data first arrives
  useEffect(() => {
    if (distributors.length > 0 && selectedDistIds.size === 0) {
      setSelectedDistIds(new Set(distributors.map((d) => d.id)));
    }
  }, [distributors, selectedDistIds.size]);

  // Competitors visible in the grid (baseline is always shown)
  const visibleDistributors = useMemo(
    () => distributors.filter((d) => d.isBaseline || selectedDistIds.has(d.id)),
    [distributors, selectedDistIds],
  );

  const colDefs = useMemo(() => buildColumns(visibleDistributors), [visibleDistributors]);

  const competitors = useMemo(() => distributors.filter((d) => !d.isBaseline), [distributors]);

  function toggleDist(id: number) {
    setSelectedDistIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelectedDistIds(on ? new Set(distributors.map((d) => d.id)) : new Set());
  }

  const rowData = useMemo(() => {
    const flat = flattenRows(data?.rows ?? []);
    return onlyMostExpensive ? flat.filter((r) => r.dickerIsMostExpensive) : flat;
  }, [data, onlyMostExpensive]);

  const rowClassRules = useMemo(
    () => ({
      "row-dicker-expensive": (p: RowClassParams<FlatRow>) => !!(p.data?.dickerIsMostExpensive),
      "row-all-stale": (p: RowClassParams<FlatRow>) => !!(p.data?.allStale),
    }),
    [],
  );

  async function handleExport() {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (brandFilter && brandFilter !== "all") params.set("brand", brandFilter);
      if (searchParam) params.set("search", searchParam);
      if (searchParam && partialMatch) params.set("partialMatch", "true");
      if (onlyMostExpensive) params.set("onlyMostExpensive", "true");

      const response = await fetch(`/api/comparison-export?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      const blob        = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match       = disposition.match(/filename="(.+?)"/);
      const filename    = match?.[1] ?? "Comparison.xlsx";

      const url = window.URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      // silent — in production a toast would be added here
    } finally {
      setExporting(false);
    }
  }

  const total = data?.total ?? null;
  const expensiveRows = useMemo(() => rowData.filter((r) => r.dickerIsMostExpensive).length, [rowData]);
  const baselineDist = distributors.find((d) => d.isBaseline);

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-7rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Competition Check</h1>
          {data && !isLoading && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {(total ?? rowData.length).toLocaleString()} products
              {baselineDist && <span> · Baseline: {baselineDist.name} ★</span>}
              {expensiveRows > 0 && (
                <span className="text-red-600 font-medium">
                  {" "}· {expensiveRows.toLocaleString()} where Dicker is most expensive ⚑
                </span>
              )}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs rounded-sm gap-1.5"
          onClick={handleExport}
          disabled={exporting || isLoading}
        >
          {exporting
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <FileDown className="h-3.5 w-3.5" />}
          {exporting ? "Generating…" : "Export"}
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-40 h-8 text-xs rounded-sm">
            <SelectValue placeholder="All brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b.id} value={b.canonicalName} className="text-xs font-mono">
                {b.canonicalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {competitors.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs rounded-sm gap-1.5 font-normal">
                Distributors
                {selectedDistIds.size < distributors.length && (
                  <span className="ml-0.5 text-primary font-semibold">
                    ({selectedDistIds.size - (distributors.find(d => d.isBaseline) ? 1 : 0)}/{competitors.length})
                  </span>
                )}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-52 p-2">
              <div className="flex items-center justify-between mb-2 pb-2 border-b">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Competitors</span>
                <div className="flex gap-2">
                  <button onClick={() => toggleAll(true)} className="text-xs text-primary hover:underline">All</button>
                  <button onClick={() => toggleAll(false)} className="text-xs text-primary hover:underline">None</button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {competitors.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 cursor-pointer group">
                    <Checkbox
                      checked={selectedDistIds.has(d.id)}
                      onCheckedChange={() => toggleDist(d.id)}
                      className="h-3.5 w-3.5 rounded-sm"
                    />
                    <span className="text-xs group-hover:text-foreground text-muted-foreground transition-colors">
                      {d.name}
                    </span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search VPN…"
          className="h-8 w-52 text-xs rounded-sm font-mono"
        />

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={partialMatch}
            onChange={(e) => setPartialMatch(e.target.checked)}
            className="rounded-sm"
          />
          Partial match
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyMostExpensive}
            onChange={(e) => setOnlyMostExpensive(e.target.checked)}
            className="rounded-sm"
          />
          Only where Dicker is most expensive
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showStaleRows}
            onChange={(e) => setShowStaleRows(e.target.checked)}
            className="rounded-sm"
          />
          Show last-known prices for delisted SKUs
        </label>

        {isLoading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </span>
        )}
      </div>

      {/* Error */}
      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-600 border border-red-200 bg-red-50 rounded-sm px-3 py-2 shrink-0">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Failed to load comparison data.
        </div>
      )}

      {/* Freshness warnings — shown when a distributor's newest committed upload has no rows */}
      {freshnessWarnings.length > 0 && (
        <div className="space-y-1 shrink-0">
          {freshnessWarnings.map((w) => (
            <Alert key={w.distributorId} className="py-2 px-3 border-amber-300 bg-amber-50 text-amber-900 rounded-sm">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <AlertDescription className="text-xs flex items-center justify-between gap-2">
                <span>
                  <strong>{w.distributorName}'s</strong> latest upload ({fmtDateDDMMYYYY(w.latestUploadDate)}) contains no data —{" "}
                  {w.fallbackDate
                    ? <>showing <strong>{fmtDateDDMMYYYY(w.fallbackDate)}</strong> prices instead.</>
                    : "no price data available."}
                </span>
                <button
                  onClick={() => setDismissedWarnings((prev) => new Set([...prev, w.distributorId]))}
                  className="shrink-0 text-amber-600 hover:text-amber-900 transition-colors"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {/* Single-SKU stacked view */}
      {!isLoading && rowData.length === 1 && (
        <div className="shrink-0">
          <SingleSkuView row={rowData[0]} distributors={visibleDistributors} />
        </div>
      )}

      {/* Grid — shown for 0 or 2+ results */}
      {(isLoading || rowData.length !== 1) && (
        <div className="flex-1 min-h-0">
          <AgGridReact
            theme={gridTheme}
            columnDefs={colDefs}
            rowData={rowData}
            rowClassRules={rowClassRules}
            pagination
            paginationPageSize={200}
            paginationPageSizeSelector={[100, 200, 500, 1000]}
            defaultColDef={{
              resizable: true,
              sortable: true,
              suppressHeaderMenuButton: true,
              filter: false,
            }}
            suppressMovableColumns
            tooltipShowDelay={400}
            loading={isLoading}
            overlayNoRowsTemplate={
              isLoading ? "Loading…" : "No products match the current filters."
            }
          />
        </div>
      )}

      <style>{`
        .row-dicker-expensive {
          background-color: #fff1f2 !important;
        }
        .row-all-stale {
          opacity: 0.45;
        }
        .ag-cell.dist-group-start {
          border-left: 2px solid #94a3b8 !important;
        }
        .ag-header-cell.dist-group-start {
          border-left: 2px solid #94a3b8 !important;
        }
      `}</style>
    </div>
  );
}
