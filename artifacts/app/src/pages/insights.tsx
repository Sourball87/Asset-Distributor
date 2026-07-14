import { useState } from "react";
import { useListBrands } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Download, Loader2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepriceTarget {
  vpn_display: string;
  description: string;
  dicker_price: number;
  cheapest_comp_price: number;
  cheapest_comp_name: string;
  cheapest_comp_soh: number;
  gap_dollars: number;
  gap_pct: number;
  dicker_soh: number;
}

interface HeadroomLine {
  vpn_display: string;
  description: string;
  dicker_price: number;
  next_cheapest_price: number;
  headroom_dollars: number;
  headroom_pct: number;
  dicker_soh: number;
}

interface CompSohEntry {
  id: number;
  name: string;
  total_soh: number;
  total_soo: number | null;
}

interface CompUndercut {
  distributor_id: number;
  disti_name: string;
  undercut_count: number;
  shared_count: number;
}

interface LostSaleLine {
  vpn_display: string;
  description: string;
  dicker_soh: number;
  competitors_in_stock: Array<{ name: string; soh: number; soo: number | null }>;
}

interface AvailWinLine {
  vpn_display: string;
  description: string;
  dicker_soh: number;
  out_of_stock_comp_count: number;
}

interface LowStockLine {
  vpn_display: string;
  description: string;
  dicker_soh: number;
  deepest_comp_name: string;
  deepest_comp_soh: number;
}

interface ExclusiveLine {
  vpn_display: string;
  description: string;
  dicker_price: number;
  dicker_soh: number;
}

interface RangeGapLine {
  vpn_display: string;
  description: string;
  competitor_name: string;
  price: number;
  soh: number;
}

interface PerCompLine {
  distributor_id: number;
  name: string;
  sku_count: number;
  shared_with_dicker: number;
}

interface InsightsData {
  brandName: string;
  snapshots: {
    dicker: { distributor_id: number; name: string; latest_date: string } | null;
    competitors: Array<{ distributor_id: number; name: string; latest_date: string }>;
  };
  distributors: {
    baseline: { id: number; name: string };
    competitors: Array<{ id: number; name: string }>;
  };
  priceCompetitiveness: {
    totalBenchmarked: number;
    winCount: number;
    winRate: number | null;
    dearer: {
      count: number;
      avgGapDollars: number;
      medianGapDollars: number;
      avgGapPct: number;
      medianGapPct: number;
    };
    aggregateExposure: number;
    repriceTargets: RepriceTarget[];
    headroom: HeadroomLine[];
    competitorUndercut: CompUndercut[];
  };
  stockPosition: {
    lostSales: { count: number; lines: LostSaleLine[] };
    availabilityWins: { count: number; lines: AvailWinLine[] };
    sohTotals: { dicker_total_soh: number; comp_soh_totals: CompSohEntry[] };
    lowStockLines: LowStockLine[];
  };
  rangeAndCoverage: {
    exclusiveCount: number;
    exclusiveLines: ExclusiveLine[];
    rangeGapCount: number;
    rangeGaps: RangeGapLine[];
    coverage: { total_dicker_skus: number; benchmarked_skus: number };
    perCompetitor: PerCompLine[];
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

type ExportSection =
  | "reprice"
  | "headroom"
  | "lost_sales"
  | "avail_wins"
  | "low_stock"
  | "exclusive_lines"
  | "range_gaps";

const SECTION_LABELS: Record<ExportSection, string> = {
  reprice: "Reprice_Targets",
  headroom: "Margin_Headroom",
  lost_sales: "Lost_Sale_Risk",
  avail_wins: "Availability_Wins",
  low_stock: "Low_Stock",
  exclusive_lines: "Exclusive_Lines",
  range_gaps: "Range_Gaps",
};

const COLUMN_MAPS: Record<ExportSection, Array<{ key: string; header: (base: string) => string }>> = {
  reprice: [
    { key: "vpn_display",         header: () => "VPN" },
    { key: "description",         header: () => "Description" },
    { key: "dicker_price",        header: (b) => `${b} Price` },
    { key: "cheapest_comp_price", header: () => "Cheapest Comp Price" },
    { key: "cheapest_comp_name",  header: () => "Competitor" },
    { key: "gap_dollars",         header: () => "Gap $" },
    { key: "gap_pct",             header: () => "Gap %" },
    { key: "dicker_soh",          header: (b) => `${b} SOH` },
  ],
  headroom: [
    { key: "vpn_display",          header: () => "VPN" },
    { key: "description",          header: () => "Description" },
    { key: "dicker_price",         header: (b) => `${b} Price` },
    { key: "next_cheapest_price",  header: () => "Next Cheapest Price" },
    { key: "headroom_dollars",     header: () => "Headroom $" },
    { key: "headroom_pct",         header: () => "Headroom %" },
    { key: "dicker_soh",           header: (b) => `${b} SOH` },
  ],
  lost_sales: [
    { key: "vpn_display",           header: () => "VPN" },
    { key: "description",           header: () => "Description" },
    { key: "dicker_soh",            header: (b) => `${b} SOH` },
    { key: "competitors_in_stock",  header: () => "Competitors in Stock" },
  ],
  avail_wins: [
    { key: "vpn_display",            header: () => "VPN" },
    { key: "description",            header: () => "Description" },
    { key: "dicker_soh",             header: (b) => `${b} SOH` },
    { key: "out_of_stock_comp_count", header: () => "Competitors OOS" },
  ],
  low_stock: [
    { key: "vpn_display",       header: () => "VPN" },
    { key: "description",       header: () => "Description" },
    { key: "dicker_soh",        header: (b) => `${b} SOH` },
    { key: "deepest_comp_name", header: () => "Deepest Competitor" },
    { key: "deepest_comp_soh",  header: () => "Their SOH" },
  ],
  exclusive_lines: [
    { key: "vpn_display",  header: () => "VPN" },
    { key: "description",  header: () => "Description" },
    { key: "dicker_price", header: (b) => `${b} Price` },
    { key: "dicker_soh",   header: (b) => `${b} SOH` },
  ],
  range_gaps: [
    { key: "vpn_display",     header: () => "VPN" },
    { key: "description",     header: () => "Description" },
    { key: "competitor_name", header: () => "Competitor" },
    { key: "price",           header: () => "Their Price" },
    { key: "soh",             header: () => "Their SOH" },
  ],
};

async function doExportSection(
  section: ExportSection,
  brandId: number,
  category: string,
  baselineName: string,
  brandName: string,
): Promise<void> {
  const params = new URLSearchParams({ brandId: String(brandId), category, section });
  const res = await fetch(`/api/insights/export?${params}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
  const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };

  const XLSX = await import("xlsx");

  let wsData: Record<string, unknown>[];
  if (section === "reprice") {
    wsData = rows.map((r) => {
      const comps = (r.all_competitors as Array<{ name: string; price: number | null; soh: number }> | null) ?? [];
      const out: Record<string, unknown> = {
        "VPN": r.vpn_display ?? "",
        "Description": r.description ?? "",
        [`${baselineName} Price`]: r.dicker_price ?? "",
        [`${baselineName} SOH`]: r.dicker_soh ?? "",
        "Cheapest Comp Price": r.cheapest_comp_price ?? "",
        "Competitor": r.cheapest_comp_name ?? "",
        "Gap $": r.gap_dollars ?? "",
        "Gap %": r.gap_pct ?? "",
      };
      for (const c of comps) {
        out[`${c.name} Price`] = c.price ?? "";
        out[`${c.name} SOH`] = c.soh ?? "";
      }
      return out;
    });
  } else {
    const cols = COLUMN_MAPS[section];
    wsData = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const { key, header } of cols) {
        out[header(baselineName)] = r[key] ?? "";
      }
      return out;
    });
  }

  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SECTION_LABELS[section].replace(/_/g, " "));

  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  const filename = `${brandName}_${SECTION_LABELS[section]}_${dd}.${mm}.${yyyy}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(Number(n)) + "%";
}

function fmtGapPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(Number(n)) + "%";
}

function fmtN(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("T")[0].split("-");
  return `${d}.${m}.${y}`;
}

function winRateColor(rate: number | null): string {
  if (rate == null) return "text-muted-foreground";
  if (rate >= 70) return "text-emerald-700";
  if (rate >= 50) return "text-amber-600";
  return "text-red-600";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "red" | "amber" | "neutral";
}) {
  const valueClass =
    accent === "green" ? "text-emerald-700"
    : accent === "red" ? "text-red-600"
    : accent === "amber" ? "text-amber-600"
    : "text-foreground";

  return (
    <div className="border border-border rounded-sm p-3 bg-card">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-xl font-mono font-semibold ${valueClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function SectionHeader({
  title,
  sub,
  onExport,
  exporting,
}: {
  title: string;
  sub?: string;
  onExport?: () => void;
  exporting?: boolean;
}) {
  return (
    <div className="flex items-start justify-between mb-3 gap-3">
      <div>
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h2>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
      {onExport && (
        <button
          onClick={onExport}
          disabled={exporting}
          className="flex-shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-sm px-2 py-1 hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          Export
        </button>
      )}
    </div>
  );
}

// ─── Tab: Price Competitiveness ───────────────────────────────────────────────

interface TabProps {
  data: InsightsData;
  doExport: (s: ExportSection) => void;
  exportingSection: ExportSection | null;
}

function PriceTab({ data, doExport, exportingSection }: TabProps) {
  const pc = data.priceCompetitiveness;
  const baseline = data.distributors.baseline;

  return (
    <div className="space-y-6">
      {/* Headline stats */}
      <div>
        <SectionHeader
          title="Headline"
          sub={`SKUs where both ${baseline.name} and at least one competitor have a price`}
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard
            label="Benchmarked SKUs"
            value={fmtN(pc.totalBenchmarked)}
            sub="with competitor data"
            accent="neutral"
          />
          <StatCard
            label="Win rate"
            value={pc.winRate != null ? fmtPct(pc.winRate) : "—"}
            sub={`${fmtN(pc.winCount)} of ${fmtN(pc.totalBenchmarked)} cheapest`}
            accent={pc.winRate != null ? (pc.winRate >= 70 ? "green" : pc.winRate >= 50 ? "amber" : "red") : "neutral"}
          />
          <StatCard
            label="Dearer on"
            value={fmtN(pc.dearer.count)}
            accent={pc.dearer.count > 0 ? "red" : "green"}
          />
        </div>
      </div>


      {/* Reprice targets */}
      {pc.repriceTargets.length > 0 && (
        <div>
          <SectionHeader
            title="Top reprice targets"
            sub="Ranked by dollar gap vs cheapest competitor — your to-do list"
            onExport={() => doExport("reprice")}
            exporting={exportingSection === "reprice"}
          />
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">{baseline.name}</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Cheapest</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-28">Competitor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-20">Gap $</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">Gap %</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">{baseline.name} SOH</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">Comp SOH</th>
                </tr>
              </thead>
              <tbody>
                {pc.repriceTargets.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt$(r.dicker_price)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-700">{fmt$(r.cheapest_comp_price)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.cheapest_comp_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-red-600">{fmt$(r.gap_dollars)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-red-600">{fmtGapPct(r.gap_pct)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(r.dicker_soh)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(r.cheapest_comp_soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Who's beating you */}
      {pc.competitorUndercut.length > 0 && (
        <div>
          <SectionHeader
            title="Who's beating you"
            sub="Per competitor: how often they undercut on shared SKUs"
          />
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Competitor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-32">Undercuts</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-32">Of shared SKUs</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Undercut %</th>
                </tr>
              </thead>
              <tbody>
                {pc.competitorUndercut
                  .slice()
                  .sort((a, b) => b.undercut_count - a.undercut_count)
                  .map((c, i) => {
                    const pct = c.shared_count > 0 ? Math.round((c.undercut_count / c.shared_count) * 1000) / 10 : 0;
                    return (
                      <tr key={c.distributor_id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                        <td className="px-3 py-1.5 font-medium text-foreground">{c.disti_name}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtN(c.undercut_count)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(c.shared_count)}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${pct > 50 ? "text-red-600" : pct > 25 ? "text-amber-600" : "text-emerald-700"}`}>
                          {fmtPct(pct)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Margin headroom */}
      {pc.headroom.length > 0 && (
        <div>
          <SectionHeader
            title="Margin headroom"
            sub="SKUs where you're cheapest — room to lift price without losing the win"
            onExport={() => doExport("headroom")}
            exporting={exportingSection === "headroom"}
          />
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">{baseline.name}</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Next cheapest</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-20">Headroom $</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">Headroom %</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">SOH</th>
                </tr>
              </thead>
              <tbody>
                {pc.headroom.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt$(r.dicker_price)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmt$(r.next_cheapest_price)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-700">{fmt$(r.headroom_dollars)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-700">{fmtPct(r.headroom_pct)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(r.dicker_soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pc.totalBenchmarked === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm border border-dashed border-border rounded-sm">
          No benchmarked SKUs — import data for both {baseline.name} and at least one competitor first.
        </div>
      )}
    </div>
  );
}

// ─── Tab: Stock Position ──────────────────────────────────────────────────────

function StockTab({ data, doExport, exportingSection }: TabProps) {
  const sp = data.stockPosition;
  const baseline = data.distributors.baseline;
  const dickerSoh = sp.sohTotals?.dicker_total_soh ?? 0;

  return (
    <div className="space-y-6">
      {/* SOH + SOO totals */}
      <div>
        <SectionHeader title="Total stock on hand / on order" sub="Summed across all SKUs for this brand" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label={`${baseline.name} SOH`} value={fmtN(dickerSoh)} accent="neutral" />
          {(sp.sohTotals?.comp_soh_totals ?? []).map((c) => (
            <StatCard
              key={c.id}
              label={`${c.name} SOH`}
              value={fmtN(c.total_soh)}
              sub={c.total_soo != null && c.total_soo > 0 ? `SOO: ${fmtN(c.total_soo)}` : undefined}
              accent="neutral"
            />
          ))}
        </div>
      </div>

      {/* Lost sales */}
      <div>
        <SectionHeader
          title={`Lost sale risk — ${fmtN(sp.lostSales.count)} lines`}
          sub={`${baseline.name} is out of stock but a competitor has units available`}
          onExport={sp.lostSales.count > 0 ? () => doExport("lost_sales") : undefined}
          exporting={exportingSection === "lost_sales"}
        />
        {sp.lostSales.lines.length > 0 ? (
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Competitors in stock</th>
                </tr>
              </thead>
              <tbody>
                {sp.lostSales.lines.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px]">{r.description}</td>
                    <td className="px-3 py-1.5">
                      {(r.competitors_in_stock ?? []).map((c) => (
                        <span key={c.name} className="inline-flex items-center gap-1 mr-3 text-muted-foreground">
                          <span className="font-medium text-foreground">{c.name}</span>
                          <span className="font-mono">{fmtN(c.soh)}</span>
                          {c.soo != null && c.soo > 0 && (
                            <span className="font-mono text-xs text-muted-foreground/70">(+{fmtN(c.soo)} OO)</span>
                          )}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-sm px-4 py-6 text-center">
            No lost-sale lines — {baseline.name} has stock on everything competitors stock.
          </div>
        )}
      </div>

      {/* Availability wins */}
      <div>
        <SectionHeader
          title={`Availability wins — ${fmtN(sp.availabilityWins.count)} lines`}
          sub={`${baseline.name} has stock and every competitor is out — push to resellers`}
          onExport={sp.availabilityWins.count > 0 ? () => doExport("avail_wins") : undefined}
          exporting={exportingSection === "avail_wins"}
        />
        {sp.availabilityWins.lines.length > 0 ? (
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">{baseline.name} SOH</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-32">Competitors OOS</th>
                </tr>
              </thead>
              <tbody>
                {sp.availabilityWins.lines.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-700">{fmtN(r.dicker_soh)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(r.out_of_stock_comp_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-sm px-4 py-6 text-center">
            No exclusive availability — competitors share stock on all {baseline.name} lines.
          </div>
        )}
      </div>

      {/* Low stock vs deep competitors */}
      {sp.lowStockLines.length > 0 && (
        <div>
          <SectionHeader
            title="Low stock — competitor is deep"
            sub={`${baseline.name} SOH 1–5 while a competitor holds 20+`}
            onExport={() => doExport("low_stock")}
            exporting={exportingSection === "low_stock"}
          />
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">{baseline.name} SOH</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-28">Deepest competitor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Their SOH</th>
                </tr>
              </thead>
              <tbody>
                {sp.lowStockLines.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-amber-600">{fmtN(r.dicker_soh)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.deepest_comp_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtN(r.deepest_comp_soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: Range & Coverage ────────────────────────────────────────────────────

function RangeTab({ data, doExport, exportingSection }: TabProps) {
  const rc = data.rangeAndCoverage;
  const baseline = data.distributors.baseline;
  const cov = rc.coverage;
  const coveragePct = cov?.total_dicker_skus > 0
    ? Math.round((cov.benchmarked_skus / cov.total_dicker_skus) * 1000) / 10
    : null;

  return (
    <div className="space-y-6">
      {/* Coverage headline */}
      <div>
        <SectionHeader
          title="Benchmark coverage"
          sub={`How much of ${baseline.name}'s range has any competitor to compare against`}
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label={`${baseline.name} SKUs`}
            value={fmtN(cov?.total_dicker_skus)}
            sub="total for this brand"
            accent="neutral"
          />
          <StatCard
            label="Benchmarked"
            value={fmtN(cov?.benchmarked_skus)}
            sub="have at least one competitor match"
            accent="neutral"
          />
          <StatCard
            label="Coverage"
            value={coveragePct != null ? fmtPct(coveragePct) : "—"}
            sub="of your range is benchmarked"
            accent={coveragePct != null ? (coveragePct >= 70 ? "green" : coveragePct >= 40 ? "amber" : "red") : "neutral"}
          />
          <StatCard
            label="Blind spot"
            value={fmtN((cov?.total_dicker_skus ?? 0) - (cov?.benchmarked_skus ?? 0))}
            sub="SKUs with no competitor data"
            accent="neutral"
          />
        </div>
      </div>

      {/* Per-competitor coverage */}
      {rc.perCompetitor.length > 0 && (
        <div>
          <SectionHeader
            title="Per-competitor coverage"
            sub="How many SKUs each competitor lists and overlaps with you"
          />
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Competitor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-28">Their SKUs</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-28">Shared with you</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Overlap %</th>
                </tr>
              </thead>
              <tbody>
                {rc.perCompetitor.map((c, i) => {
                  const overlapPct = c.sku_count > 0
                    ? Math.round((c.shared_with_dicker / c.sku_count) * 1000) / 10
                    : 0;
                  return (
                    <tr key={c.distributor_id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                      <td className="px-3 py-1.5 font-medium text-foreground">{c.name}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtN(c.sku_count)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtN(c.shared_with_dicker)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtPct(overlapPct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Exclusive lines */}
      <div>
        <SectionHeader
          title={`Exclusive lines — ${fmtN(rc.exclusiveCount)} SKUs`}
          sub={`You carry these, no competitor lists them — no price pressure`}
          onExport={rc.exclusiveCount > 0 ? () => doExport("exclusive_lines") : undefined}
          exporting={exportingSection === "exclusive_lines"}
        />
        {rc.exclusiveLines.length > 0 ? (
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">{baseline.name} Price</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-20">{baseline.name} SOH</th>
                </tr>
              </thead>
              <tbody>
                {rc.exclusiveLines.map((r, i) => (
                  <tr key={r.vpn_display} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt$(r.dicker_price)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtN(r.dicker_soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-sm px-4 py-6 text-center">
            No exclusive lines — all your SKUs appear in at least one competitor catalogue.
          </div>
        )}
      </div>

      {/* Range gaps */}
      <div>
        <SectionHeader
          title={`Range gaps — ${fmtN(rc.rangeGapCount)} in-stock lines`}
          sub="Competitors carry these with stock but you don't — sourcing shortlist"
          onExport={rc.rangeGapCount > 0 ? () => doExport("range_gaps") : undefined}
          exporting={exportingSection === "range_gaps"}
        />
        {rc.rangeGaps.length > 0 ? (
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">VPN</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-28">Competitor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-24">Their Price</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-20">Their SOH</th>
                </tr>
              </thead>
              <tbody>
                {rc.rangeGaps.map((r, i) => (
                  <tr key={`${r.vpn_display}-${r.competitor_name}`} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <td className="px-3 py-1.5 font-mono text-foreground">{r.vpn_display}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{r.description}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.competitor_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt$(r.price)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtN(r.soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-sm px-4 py-6 text-center">
            No range gaps with in-stock competitors.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const [brandId, setBrandId] = useState<number | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [exportingSection, setExportingSection] = useState<ExportSection | null>(null);
  const { data: brands } = useListBrands();

  const { data: categoriesData } = useQuery<{ categories: string[] }>({
    queryKey: ["insights-categories", brandId],
    queryFn: async () => {
      const res = await fetch(`/api/insights/categories?brandId=${brandId}`, { credentials: "include" });
      if (!res.ok) return { categories: [] };
      return res.json();
    },
    enabled: brandId != null,
  });
  const categories = categoriesData?.categories ?? [];

  const { data: insights, isLoading, error } = useQuery<InsightsData>({
    queryKey: ["insights", brandId, category],
    queryFn: async () => {
      const params = new URLSearchParams({ brandId: String(brandId) });
      if (category !== "All") params.set("category", category);
      const res = await fetch(`/api/insights?${params}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: brandId != null,
  });

  const dickerSnap = insights?.snapshots?.dicker;
  const compSnaps = insights?.snapshots?.competitors ?? [];

  function handleBrandChange(v: string) {
    setBrandId(v ? Number(v) : null);
    setCategory("All");
  }

  function doExport(section: ExportSection) {
    if (!brandId || !insights) return;
    setExportingSection(section);
    doExportSection(
      section,
      brandId,
      category,
      insights.distributors.baseline.name,
      insights.brandName,
    )
      .catch((e) => console.error("Export error:", e))
      .finally(() => setExportingSection(null));
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Insights</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pricing competitiveness, stock position and range coverage — by brand
          </p>
        </div>

        {/* Selectors + snapshot dates */}
        <div className="flex items-center gap-3">
          {insights && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {dickerSnap && (
                <span>
                  <span className="font-medium text-foreground">{dickerSnap.name}</span>{" "}
                  {fmtDate(dickerSnap.latest_date)}
                </span>
              )}
              {compSnaps.map((c) => (
                <span key={c.distributor_id}>
                  · <span className="font-medium text-foreground">{c.name}</span>{" "}
                  {fmtDate(c.latest_date)}
                </span>
              ))}
            </div>
          )}

          {/* Category selector — shown once a brand is picked and categories exist */}
          {brandId != null && categories.length > 0 && (
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-8 text-xs rounded-sm w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All" className="text-xs">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Brand selector */}
          <Select
            value={brandId != null ? String(brandId) : ""}
            onValueChange={handleBrandChange}
          >
            <SelectTrigger className="h-8 text-xs rounded-sm w-44">
              <span className="truncate">
                {brandId != null
                  ? (brands?.find((b) => b.id === brandId)?.canonicalName ?? "Select brand")
                  : "Select brand"}
              </span>
            </SelectTrigger>
            <SelectContent>
              {(brands ?? []).map((b) => (
                <SelectItem key={b.id} value={String(b.id)} className="text-xs">
                  {b.canonicalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Empty state */}
      {!brandId && (
        <div className="border border-dashed border-border rounded-sm py-20 text-center text-muted-foreground text-sm">
          Select a brand above to load insights
        </div>
      )}

      {/* Loading */}
      {brandId && isLoading && (
        <div className="flex items-center justify-center py-20 gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading insights…
        </div>
      )}

      {/* Error */}
      {brandId && error && (
        <div className="flex items-center gap-2 py-8 text-destructive text-sm justify-center">
          <AlertCircle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}

      {/* Insights */}
      {insights && !isLoading && (
        <Tabs defaultValue="price">
          <TabsList className="h-8 rounded-sm">
            <TabsTrigger value="price" className="text-xs h-7 rounded-sm px-4">
              Price competitiveness
              {insights.priceCompetitiveness.winRate != null && (
                <span className={`ml-2 font-mono ${winRateColor(insights.priceCompetitiveness.winRate)}`}>
                  {fmtPct(insights.priceCompetitiveness.winRate)}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="stock" className="text-xs h-7 rounded-sm px-4">
              Stock position
              {insights.stockPosition.lostSales.count > 0 && (
                <span className="ml-2 font-mono text-red-600">
                  {fmtN(insights.stockPosition.lostSales.count)} lost
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="range" className="text-xs h-7 rounded-sm px-4">
              Range &amp; coverage
              {insights.rangeAndCoverage.coverage?.total_dicker_skus > 0 && (
                <span className="ml-2 font-mono text-muted-foreground">
                  {fmtN(insights.rangeAndCoverage.coverage.total_dicker_skus)} SKUs
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="price" className="mt-4">
            <PriceTab data={insights} doExport={doExport} exportingSection={exportingSection} />
          </TabsContent>
          <TabsContent value="stock" className="mt-4">
            <StockTab data={insights} doExport={doExport} exportingSection={exportingSection} />
          </TabsContent>
          <TabsContent value="range" className="mt-4">
            <RangeTab data={insights} doExport={doExport} exportingSection={exportingSection} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
