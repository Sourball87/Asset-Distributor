import { useState } from "react";
import { useListBrands } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepriceTarget {
  vpn_display: string;
  description: string;
  dicker_price: number;
  cheapest_comp_price: number;
  cheapest_comp_name: string;
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
  competitors_in_stock: Array<{ name: string; soh: number }>;
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
    sohTotals: { dicker_total_soh: number; comp_soh_totals: Array<{ id: number; name: string; total: number }> };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toFixed(1) + "%";
}

function fmtN(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
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

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h2>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Tab: Price Competitiveness ───────────────────────────────────────────────

function PriceTab({ data }: { data: InsightsData }) {
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
            sub={`avg gap ${fmt$(pc.dearer.avgGapDollars)} · median ${fmt$(pc.dearer.medianGapDollars)}`}
            accent={pc.dearer.count > 0 ? "red" : "green"}
          />
          <StatCard
            label="Aggregate exposure"
            value={fmt$(pc.aggregateExposure)}
            sub="gap × SOH on in-stock losers"
            accent={pc.aggregateExposure > 0 ? "red" : "green"}
          />
        </div>
      </div>

      {/* Gap detail */}
      {pc.dearer.count > 0 && (
        <div>
          <SectionHeader
            title="Gap detail (where dearer)"
            sub="Measured against cheapest competitor price, regardless of stock"
          />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Avg gap $" value={fmt$(pc.dearer.avgGapDollars)} accent="neutral" />
            <StatCard label="Median gap $" value={fmt$(pc.dearer.medianGapDollars)} accent="neutral" />
            <StatCard label="Avg gap %" value={fmtPct(pc.dearer.avgGapPct)} accent="neutral" />
            <StatCard label="Median gap %" value={fmtPct(pc.dearer.medianGapPct)} accent="neutral" />
          </div>
        </div>
      )}

      {/* Reprice targets */}
      {pc.repriceTargets.length > 0 && (
        <div>
          <SectionHeader
            title="Top reprice targets"
            sub="Ranked by dollar gap vs cheapest in-stock competitor — your to-do list"
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
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-16">SOH</th>
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
                    <td className="px-3 py-1.5 text-right font-mono text-red-600">{fmtPct(r.gap_pct)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtN(r.dicker_soh)}</td>
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

function StockTab({ data }: { data: InsightsData }) {
  const sp = data.stockPosition;
  const baseline = data.distributors.baseline;
  const dickerSoh = sp.sohTotals?.dicker_total_soh ?? 0;

  return (
    <div className="space-y-6">
      {/* SOH totals */}
      <div>
        <SectionHeader title="Total stock on hand" sub="Summed across all SKUs for this brand" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label={`${baseline.name} SOH`} value={fmtN(dickerSoh)} accent="neutral" />
          {(sp.sohTotals?.comp_soh_totals ?? []).map((c) => (
            <StatCard key={c.id} label={`${c.name} SOH`} value={fmtN(c.total)} accent="neutral" />
          ))}
        </div>
      </div>

      {/* Lost sales */}
      <div>
        <SectionHeader
          title={`Lost sale risk — ${fmtN(sp.lostSales.count)} lines`}
          sub={`${baseline.name} is out of stock but a competitor has units available`}
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

function RangeTab({ data }: { data: InsightsData }) {
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
  const { data: brands } = useListBrands();

  const { data: insights, isLoading, error } = useQuery<InsightsData>({
    queryKey: ["insights", brandId],
    queryFn: async () => {
      const res = await fetch(`/api/insights?brandId=${brandId}`, { credentials: "include" });
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

        {/* Brand selector */}
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
          <Select
            value={brandId != null ? String(brandId) : ""}
            onValueChange={(v) => setBrandId(v ? Number(v) : null)}
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
            <PriceTab data={insights} />
          </TabsContent>
          <TabsContent value="stock" className="mt-4">
            <StockTab data={insights} />
          </TabsContent>
          <TabsContent value="range" className="mt-4">
            <RangeTab data={insights} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
