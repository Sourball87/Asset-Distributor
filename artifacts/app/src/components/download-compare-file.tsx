import { useState } from "react";
import { useListBrands } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, Loader2 } from "lucide-react";

const PRICE_FORMAT = "$#,##0.00";

export function DownloadCompareFile() {
  const { data: brandsData } = useListBrands();
  const allBrands = (brandsData ?? []).map((b) => b.canonicalName).sort();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = allBrands.length > 0 && selected.size === allBrands.length;
  const noneSelected = selected.size === 0;

  function toggle(brand: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(brand)) next.delete(brand);
      else next.add(brand);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allBrands));
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const brands = selected.size > 0 ? Array.from(selected).sort().join(",") : "";
      const url = brands ? `/api/compare-file?brands=${encodeURIComponent(brands)}` : `/api/compare-file`;
      const response = await fetch(url, { credentials: "include" });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Server returned ${response.status}`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match?.[1] ?? "Compare.xlsx";

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

  const brandLabel = noneSelected
    ? "All brands"
    : Array.from(selected).sort().join(", ");

  return (
    <div className="border border-border rounded-sm bg-card">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="font-semibold text-sm">Download Compare File</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Excel workbook — pre-filled with current distributor pricing &amp; stock
          </div>
        </div>
        <Button
          size="sm"
          className="h-7 text-xs rounded-sm gap-1.5"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {downloading ? "Generating…" : "Download"}
        </Button>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Brand filter
          </span>
          <div className="flex gap-2 text-xs">
            <button
              className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onClick={selectAll}
              type="button"
            >
              All
            </button>
            <span className="text-muted-foreground/40">|</span>
            <button
              className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onClick={clearAll}
              type="button"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
          {allBrands.map((brand) => (
            <label
              key={brand}
              className="flex items-center gap-2 cursor-pointer group"
            >
              <Checkbox
                checked={selected.has(brand)}
                onCheckedChange={() => toggle(brand)}
                className="rounded-sm h-3.5 w-3.5"
              />
              <span className="text-xs font-mono text-foreground group-hover:text-primary">
                {brand}
              </span>
            </label>
          ))}
        </div>

        {!noneSelected && (
          <div className="mt-2 text-xs text-muted-foreground">
            Selected:{" "}
            <span className="font-mono text-foreground">{brandLabel}</span>
          </div>
        )}
        {noneSelected && (
          <div className="mt-2 text-xs text-muted-foreground italic">
            No brands selected — will include all brands
          </div>
        )}

        {error && (
          <div className="mt-2 text-xs text-red-600 border border-red-200 bg-red-50 rounded-sm px-2 py-1">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
