import { useState, useMemo, useEffect } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz } from "ag-grid-community";
import type { ColDef, ColGroupDef, RowClassParams, ValueFormatterParams, CellClassParams, CellStyle } from "ag-grid-community";
import {
  useGetComparison,
  useListBrands,
  type ComparisonRow,
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
import { Loader2, AlertCircle } from "lucide-react";

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
  return `$${v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSoh(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-AU");
}

function fmtDelta(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs} ▲` : `+$${abs} ▼`;
}

function fmtDeltaPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
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
    };
    for (const d of row.distributors) {
      flat[`d${d.distributorId}_price`]    = d.sellPrice ?? null;
      flat[`d${d.distributorId}_soh`]      = d.soh ?? null;
      flat[`d${d.distributorId}_delta`]    = d.priceDelta ?? null;
      flat[`d${d.distributorId}_deltaPct`] = d.priceDeltaPct ?? null;
      flat[`d${d.distributorId}_cheapest`] = row.cheapestCompetitorId === d.distributorId;
    }
    return flat;
  });
}

// ---------------------------------------------------------------------------
// Column builder
// ---------------------------------------------------------------------------

const MONO: CellStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };

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
      flex: 1,
      minWidth: 160,
      maxWidth: 320,
      tooltipField: "description",
    },
  ];

  const distGroups: ColGroupDef[] = distributors.map((d) => {
    const priceCol: ColDef = {
      headerName: "Price",
      colId: `d${d.id}_price`,
      field: `d${d.id}_price`,
      width: 95,
      type: "rightAligned",
      cellStyle: MONO,
      valueFormatter: (p: ValueFormatterParams) => fmtPrice(p.value as number | null),
      comparator: (a: number | null, b: number | null) => (a ?? -Infinity) - (b ?? -Infinity),
    };

    const sohCol: ColDef = {
      headerName: "SOH",
      colId: `d${d.id}_soh`,
      field: `d${d.id}_soh`,
      width: 68,
      type: "rightAligned",
      cellStyle: MONO,
      valueFormatter: (p: ValueFormatterParams) => fmtSoh(p.value as number | null),
      comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
    };

    if (d.isBaseline) {
      return {
        headerName: d.name + " ★",
        children: [priceCol, sohCol],
      };
    }

    const deltaCol: ColDef = {
      headerName: "Δ vs Dicker",
      colId: `d${d.id}_delta`,
      field: `d${d.id}_delta`,
      width: 108,
      type: "rightAligned",
      cellStyle: (p: CellClassParams): CellStyle => {
        const v = p.value as number | null;
        if (v == null) return MONO;
        return { ...MONO, color: v < 0 ? "#dc2626" : "#16a34a", fontWeight: "600" } as CellStyle;
      },
      valueFormatter: (p: ValueFormatterParams) => fmtDelta(p.value as number | null),
      comparator: (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0),
    };

    const deltaPctCol: ColDef = {
      headerName: "Δ %",
      colId: `d${d.id}_deltaPct`,
      field: `d${d.id}_deltaPct`,
      width: 66,
      type: "rightAligned",
      cellStyle: (p: CellClassParams): CellStyle => {
        const v = p.value as number | null;
        if (v == null) return MONO;
        return { ...MONO, color: v < 0 ? "#dc2626" : "#16a34a" } as CellStyle;
      },
      valueFormatter: (p: ValueFormatterParams) => fmtDeltaPct(p.value as number | null),
      comparator: (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0),
    };

    return {
      headerName: d.name,
      children: [priceCol, sohCol, deltaCol, deltaPctCol],
    };
  });

  const flagsGroup: ColGroupDef = {
    headerName: "Flags",
    children: [
      {
        headerName: "DD ↑",
        colId: "dickerIsMostExpensive",
        field: "dickerIsMostExpensive",
        width: 54,
        headerTooltip: "Dicker Data is the most expensive among all distributors with data",
        cellStyle: { ...MONO, color: "#dc2626", textAlign: "center" } as CellStyle,
        valueFormatter: (p: ValueFormatterParams) => (p.value ? "⚑" : ""),
        comparator: (a: boolean, b: boolean) => Number(a) - Number(b),
      },
    ],
  };

  return [...leftPinned, ...distGroups, flagsGroup];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Comparison() {
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [onlyMostExpensive, setOnlyMostExpensive] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchParam, setSearchParam] = useState("");

  const { data: brandsData } = useListBrands();
  const brands = brandsData ?? [];

  // Debounce search: only send to API 400 ms after the user stops typing
  useEffect(() => {
    const t = setTimeout(() => setSearchParam(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (brandFilter && brandFilter !== "all") p.brand = brandFilter;
    if (searchParam) p.search = searchParam;
    return Object.keys(p).length ? p : undefined;
  }, [brandFilter, searchParam]);

  const { data, isLoading, isError } = useGetComparison(queryParams, {
    query: { staleTime: 60_000, queryKey: ["comparison", queryParams] },
  });

  const distributors: Distributor[] = useMemo(() => data?.distributors ?? [], [data]);
  const colDefs = useMemo(() => buildColumns(distributors), [distributors]);

  const rowData = useMemo(() => {
    const flat = flattenRows(data?.rows ?? []);
    return onlyMostExpensive ? flat.filter((r) => r.dickerIsMostExpensive) : flat;
  }, [data, onlyMostExpensive]);

  const rowClassRules = useMemo(
    () => ({
      "row-dicker-expensive": (p: RowClassParams<FlatRow>) => !!(p.data?.dickerIsMostExpensive),
    }),
    [],
  );

  const total = data?.total ?? null;
  const expensiveRows = useMemo(() => rowData.filter((r) => r.dickerIsMostExpensive).length, [rowData]);
  const baselineDist = distributors.find((d) => d.isBaseline);

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-7rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Comparison Grid</h1>
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

        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search VPN or description…"
          className="h-8 w-60 text-xs rounded-sm font-mono"
        />

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyMostExpensive}
            onChange={(e) => setOnlyMostExpensive(e.target.checked)}
            className="rounded-sm"
          />
          Only where Dicker is most expensive
        </label>

        {isLoading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
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

      {/* Grid */}
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

      <style>{`
        .row-dicker-expensive {
          background-color: #fff1f2 !important;
        }
      `}</style>
    </div>
  );
}
