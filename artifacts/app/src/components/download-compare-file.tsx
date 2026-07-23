import { useState } from "react";
import { useListBrands, useListDistributors } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, Loader2, LayoutList, LayoutGrid } from "lucide-react";

type Format = "vertical" | "horizontal";

function FormatPickerModal({
  onPick,
  onCancel,
}: {
  onPick: (f: Format) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-sm shadow-xl w-[420px] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">Choose download format</div>
        <div className="text-xs text-muted-foreground mb-4">
          Select how you want the Excel file laid out.
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Vertical */}
          <button
            type="button"
            onClick={() => onPick("vertical")}
            className="flex flex-col items-start gap-2 border border-border rounded-sm px-4 py-3 text-left hover:border-primary hover:bg-muted/40 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <LayoutList className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
              <span className="text-sm font-semibold">Vertical</span>
            </div>
            <span className="text-xs text-muted-foreground leading-snug">
              Lookup tool — paste SKUs into yellow cells, cards build automatically. One card per part, stacked vertically.
            </span>
          </button>

          {/* Horizontal */}
          <button
            type="button"
            onClick={() => onPick("horizontal")}
            className="flex flex-col items-start gap-2 border border-border rounded-sm px-4 py-3 text-left hover:border-primary hover:bg-muted/40 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
              <span className="text-sm font-semibold">Horizontal</span>
            </div>
            <span className="text-xs text-muted-foreground leading-snug">
              Comparison grid — one row per part, columns grouped by distributor with price deltas vs Dicker.
            </span>
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function DownloadCompareFile() {
  const { data: brandsData }      = useListBrands();
  const { data: distributorsData } = useListDistributors();

  const allBrands      = (brandsData ?? []).filter((b) => !b.referenceOnly).map((b) => b.canonicalName).sort();
  const allCompetitors = (distributorsData ?? []).filter((d) => !d.isBaseline);

  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedDists,  setSelectedDists]  = useState<Set<number>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [showFormatPicker, setShowFormatPicker] = useState(false);

  const noBrandsSelected = selectedBrands.size === 0;
  const noDistsSelected  = selectedDists.size  === 0;

  function toggleBrand(brand: string) {
    setSelectedBrands((prev) => {
      const next = new Set(prev);
      if (next.has(brand)) next.delete(brand); else next.add(brand);
      return next;
    });
  }
  function toggleDist(id: number) {
    setSelectedDists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleDownload(format: Format) {
    setShowFormatPicker(false);
    setDownloading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedBrands.size > 0) params.set("brands", Array.from(selectedBrands).sort().join(","));
      if (selectedDists.size  > 0) params.set("distributors", Array.from(selectedDists).sort((a, b) => a - b).join(","));
      params.set("format", format);

      const url = `/api/compare-file?${params.toString()}`;

      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Server returned ${response.status}`);
      }

      const blob        = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match       = disposition.match(/filename="(.+?)"/);
      const filename    = match?.[1] ?? "Compare.xlsx";

      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      {showFormatPicker && (
        <FormatPickerModal
          onPick={handleDownload}
          onCancel={() => setShowFormatPicker(false)}
        />
      )}

      <div className="border border-border rounded-sm bg-card">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="font-semibold text-sm">Download Compare File</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Excel workbook — vertical lookup tool or horizontal comparison grid
            </div>
          </div>
          <Button
            size="sm"
            className="h-7 text-xs rounded-sm gap-1.5"
            onClick={() => setShowFormatPicker(true)}
            disabled={downloading}
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {downloading ? "Generating…" : "Download"}
          </Button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {/* Brand filter */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Brand filter</span>
              <div className="flex gap-2 text-xs">
                <button
                  className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => setSelectedBrands(new Set(allBrands))}
                  type="button"
                >All</button>
                <span className="text-muted-foreground/40">|</span>
                <button
                  className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => setSelectedBrands(new Set())}
                  type="button"
                >Clear</button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
              {allBrands.map((brand) => (
                <label key={brand} className="flex items-center gap-2 cursor-pointer group">
                  <Checkbox
                    checked={selectedBrands.has(brand)}
                    onCheckedChange={() => toggleBrand(brand)}
                    className="rounded-sm h-3.5 w-3.5"
                  />
                  <span className="text-xs font-mono text-foreground group-hover:text-primary">{brand}</span>
                </label>
              ))}
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground italic">
              {noBrandsSelected
                ? "No brands selected — will include all brands"
                : <>Selected: <span className="font-mono not-italic text-foreground">{Array.from(selectedBrands).sort().join(", ")}</span></>}
            </div>
          </div>

          {/* Distributor filter */}
          {allCompetitors.length > 0 && (
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Distributors</span>
                <div className="flex gap-2 text-xs">
                  <button
                    className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    onClick={() => setSelectedDists(new Set(allCompetitors.map((d) => d.id)))}
                    type="button"
                  >All</button>
                  <span className="text-muted-foreground/40">|</span>
                  <button
                    className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    onClick={() => setSelectedDists(new Set())}
                    type="button"
                  >Clear</button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
                {allCompetitors.map((dist) => (
                  <label key={dist.id} className="flex items-center gap-2 cursor-pointer group">
                    <Checkbox
                      checked={selectedDists.has(dist.id)}
                      onCheckedChange={() => toggleDist(dist.id)}
                      className="rounded-sm h-3.5 w-3.5"
                    />
                    <span className="text-xs font-mono text-foreground group-hover:text-primary">{dist.name}</span>
                  </label>
                ))}
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground italic">
                {noDistsSelected
                  ? "No distributors selected — will include all distributors"
                  : <>Selected: <span className="font-mono not-italic text-foreground">{allCompetitors.filter((d) => selectedDists.has(d.id)).map((d) => d.name).join(", ")}</span></>}
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-sm px-2 py-1">
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
