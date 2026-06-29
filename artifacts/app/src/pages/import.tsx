import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useListDistributors,
  useCommitUpload,
  getListUploadsQueryKey,
  type ParsePreview,
  type ColumnMapping,
  type ImportProfile,
  CommitUploadInputSourceFormat,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileUp, CheckCircle2, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suggestColumn(columns: string[], keywords: string[]): string {
  const normalizedCols = columns.map((c) => c.toLowerCase().trim());
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    const idx = normalizedCols.findIndex(
      (c) => c === kwLower || c.includes(kwLower) || kwLower.includes(c)
    );
    if (idx !== -1) return columns[idx];
  }
  return "";
}

function buildDefaultMapping(
  columns: string[],
  profile?: ImportProfile | null
): ColumnMapping {
  if (profile) return { ...profile.mapping };
  return {
    vpn: suggestColumn(columns, [
      "vendor part number",
      "manufacturer_part_number",
      "manufacturer sku",
      "part number",
      "part_number",
      "vpn",
      "sku",
    ]),
    brand: suggestColumn(columns, [
      "vendor name",
      "manufacturer_name",
      "manufacturer",
      "brand",
      "vendor",
    ]),
    description: suggestColumn(columns, [
      "ingram part description",
      "short_description",
      "short description",
      "long description",
      "description",
      "material long",
    ]),
    sell_price: suggestColumn(columns, [
      "customer price",
      "reseller_buy_ex",
      "dbp",
      "sell price",
      "buy price",
      "price",
    ]),
    soh: suggestColumn(columns, [
      "available quantity",
      "total_availability",
      "soh",
      "qty on hand",
      "stock on hand",
      "at",
    ]),
    soo:
      suggestColumn(columns, [
        "backlog information",
        "backlog",
        "soo",
        "on order",
        "stock on order",
      ]) || null,
  };
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

function fileSourceFormat(
  filename: string
): (typeof CommitUploadInputSourceFormat)[keyof typeof CommitUploadInputSourceFormat] {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx" || ext === "xls") return CommitUploadInputSourceFormat.xlsx;
  return CommitUploadInputSourceFormat.txt;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS = ["Upload", "Mapping", "Preview", "Done"];

function StepBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1 mb-6">
      {STEPS.map((label, i) => {
        const active = i + 1 === current;
        const done = i + 1 < current;
        return (
          <div key={i} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-medium border ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : done
                  ? "border-border bg-secondary text-secondary-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              <span>{i + 1}</span>
              <span>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column selector helper
// ---------------------------------------------------------------------------

function ColSelect({
  label,
  required,
  value,
  columns,
  onChange,
}: {
  label: string;
  required?: boolean;
  value: string;
  columns: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-3">
      <Label className="text-xs text-right text-muted-foreground">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 text-xs rounded-sm font-mono">
          <SelectValue placeholder="— not mapped —" />
        </SelectTrigger>
        <SelectContent>
          {!required && (
            <SelectItem value="__none__" className="text-xs font-mono text-muted-foreground">
              — not mapped —
            </SelectItem>
          )}
          {columns.map((c) => (
            <SelectItem key={c} value={c} className="text-xs font-mono">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ImportPage() {
  const [step, setStep] = useState(1);

  // Step 1 state
  const [distributorId, setDistributorId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // After parse
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Step 2 state
  const [mapping, setMapping] = useState<ColumnMapping>({
    vpn: "",
    brand: "",
    description: "",
    sell_price: "",
    soh: "",
    soo: null,
  });
  const [snapshotDate, setSnapshotDate] = useState(todayIso());
  const [saveProfile, setSaveProfile] = useState(false);

  // Step 3 → 4
  const [commitResult, setCommitResult] = useState<{
    rowCountMatched: number;
    distributorName: string;
    snapshotDate: string;
  } | null>(null);

  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: distributors } = useListDistributors();

  // Parse mutation (custom — generated hook doesn't include file in FormData)
  const parseMutation = useMutation({
    mutationFn: async ({ f, distId }: { f: File; distId: number }) => {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("distributorId", String(distId));
      const res = await fetch("/api/uploads/parse", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Parse failed");
      }
      return res.json() as Promise<ParsePreview>;
    },
    onSuccess: (data) => {
      setPreview(data);
      setParseError(null);
      const suggested = buildDefaultMapping(data.columns, data.profile);
      setMapping(suggested);
      setSaveProfile(!data.hasProfile);
      setStep(2);
    },
    onError: (e: Error) => {
      setParseError(e.message);
    },
  });

  const commitMutation = useCommitUpload({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
        const dist = distributors?.find((d) => d.id === distributorId);
        setCommitResult({
          rowCountMatched: result.rowCountMatched,
          distributorName: dist?.name ?? String(distributorId),
          snapshotDate: result.snapshotDate,
        });
        setStep(4);
      },
    },
  });

  // -------------------------------------------------------------------------
  // File handling
  // -------------------------------------------------------------------------

  function handleFileAccept(f: File) {
    setFile(f);
    setParseError(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileAccept(f);
  }

  // -------------------------------------------------------------------------
  // Step actions
  // -------------------------------------------------------------------------

  function handleParse() {
    if (!file || !distributorId) return;
    parseMutation.mutate({ f: file, distId: distributorId });
  }

  function handleCommit() {
    if (!preview || !distributorId || !file) return;
    const det = preview.detectedDelimiter;
    const delim = det === "\t" ? "tab" : det === "|" ? "pipe" : det ?? undefined;
    const fmt = fileSourceFormat(file.name);
    commitMutation.mutate({
      data: {
        distributorId,
        tempFileKey: preview.tempFileKey,
        mapping,
        sourceFormat: fmt,
        delimiter: delim,
        headerRowIndex: preview.profile?.headerRowIndex ?? 0,
        snapshotDate,
        saveProfile,
      },
    });
  }

  function handleReset() {
    setStep(1);
    setFile(null);
    setPreview(null);
    setParseError(null);
    setCommitResult(null);
    setMapping({ vpn: "", brand: "", description: "", sell_price: "", soh: "", soo: null });
  }

  // -------------------------------------------------------------------------
  // Mapping helper
  // -------------------------------------------------------------------------

  function setField(field: keyof ColumnMapping, val: string) {
    setMapping((m) => ({
      ...m,
      [field]: field === "soo" ? (val === "__none__" ? null : val) : val,
    }));
  }

  const mappingComplete =
    !!mapping.vpn && !!mapping.brand && !!mapping.sell_price && !!mapping.soh;

  // -------------------------------------------------------------------------
  // Preview rows — extract mapped columns only
  // -------------------------------------------------------------------------

  const previewRows = (preview?.rows ?? []).slice(0, 50).map((row) => ({
    vpn: String((row as Record<string, unknown>)[mapping.vpn] ?? ""),
    brand: String((row as Record<string, unknown>)[mapping.brand] ?? ""),
    description: String((row as Record<string, unknown>)[mapping.description] ?? ""),
    sell_price: String((row as Record<string, unknown>)[mapping.sell_price] ?? ""),
    soh: String(mapping.soh ? (row as Record<string, unknown>)[mapping.soh] ?? "" : ""),
    soo: mapping.soo ? String((row as Record<string, unknown>)[mapping.soo] ?? "") : "",
  }));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-foreground">Import Snapshot</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Upload a distributor price file and map columns to commit a new stock snapshot.
        </p>
      </div>

      <StepBar current={step} />

      {/* ------------------------------------------------------------------ */}
      {/* Step 1: Upload                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === 1 && (
        <div className="bg-card border border-border rounded-sm p-5 space-y-5 max-w-xl">
          {/* Distributor */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Distributor <span className="text-destructive">*</span>
            </Label>
            <Select
              value={distributorId ? String(distributorId) : ""}
              onValueChange={(v) => setDistributorId(Number(v))}
            >
              <SelectTrigger className="h-8 text-sm rounded-sm">
                <SelectValue placeholder="Select distributor…" />
              </SelectTrigger>
              <SelectContent>
                {(distributors ?? []).map((d) => (
                  <SelectItem key={d.id} value={String(d.id)} className="text-sm">
                    {d.name}
                    {d.isBaseline && (
                      <span className="ml-2 text-xs text-muted-foreground">(baseline)</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Drop zone */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              File <span className="text-destructive">*</span>
            </Label>
            <div
              className={`border-2 border-dashed rounded-sm p-8 text-center cursor-pointer transition-colors ${
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              {file ? (
                <div>
                  <p className="text-sm font-medium text-foreground font-mono">{file.name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {(file.size / 1024).toFixed(0)} KB — click to change
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">
                    Drop file here or <span className="text-primary underline">browse</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    .xlsx, .csv, .txt supported (up to 50 MB)
                  </p>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileAccept(f);
              }}
            />
          </div>

          {parseError && (
            <Alert variant="destructive" className="rounded-sm py-2 px-3">
              <AlertDescription className="text-xs">{parseError}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleParse}
            disabled={!file || !distributorId || parseMutation.isPending}
            className="h-8 rounded-sm text-xs"
          >
            {parseMutation.isPending ? "Parsing…" : "Parse File →"}
          </Button>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 2: Mapping                                                      */}
      {/* ------------------------------------------------------------------ */}
      {step === 2 && preview && (
        <div className="bg-card border border-border rounded-sm p-5 space-y-5 max-w-2xl">
          {preview.hasProfile && (
            <Alert className="rounded-sm py-2 px-3 border-amber-200 bg-amber-50">
              <AlertDescription className="text-xs text-amber-800">
                Mapping loaded from saved profile — review and adjust if needed.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Column Mapping</h2>
            <p className="text-xs text-muted-foreground">
              {preview.columns.length} columns detected from{" "}
              <span className="font-mono">{file?.name}</span>
              {preview.detectedDelimiter &&
                preview.detectedDelimiter !== "," && (
                  <span className="ml-1 text-muted-foreground">
                    (
                    {preview.detectedDelimiter === "\t"
                      ? "tab-separated"
                      : preview.detectedDelimiter === "|"
                      ? "pipe-separated"
                      : `delimiter: "${preview.detectedDelimiter}"`}
                    )
                  </span>
                )}
            </p>
          </div>

          <div className="space-y-2.5">
            <ColSelect
              label="VPN (part number)"
              required
              value={mapping.vpn}
              columns={preview.columns}
              onChange={(v) => setField("vpn", v)}
            />
            <ColSelect
              label="Brand"
              required
              value={mapping.brand}
              columns={preview.columns}
              onChange={(v) => setField("brand", v)}
            />
            <ColSelect
              label="Description"
              value={mapping.description}
              columns={preview.columns}
              onChange={(v) => setField("description", v)}
            />
            <ColSelect
              label="Sell Price"
              required
              value={mapping.sell_price}
              columns={preview.columns}
              onChange={(v) => setField("sell_price", v)}
            />
            <ColSelect
              label="SOH (stock on hand)"
              required
              value={mapping.soh}
              columns={preview.columns}
              onChange={(v) => setField("soh", v)}
            />
            <ColSelect
              label="SOO (on order, optional)"
              value={mapping.soo ?? "__none__"}
              columns={preview.columns}
              onChange={(v) => setField("soo", v)}
            />
          </div>

          <div className="border-t border-border pt-4 space-y-3">
            <div className="grid grid-cols-[180px_1fr] items-center gap-3">
              <Label className="text-xs text-right text-muted-foreground">Snapshot date</Label>
              <Input
                type="date"
                value={snapshotDate}
                onChange={(e) => setSnapshotDate(e.target.value)}
                className="h-7 text-xs rounded-sm w-40 font-mono"
              />
            </div>

            <div className="grid grid-cols-[180px_1fr] items-center gap-3">
              <div />
              <div className="flex items-center gap-2">
                <Checkbox
                  id="save-profile"
                  checked={saveProfile}
                  onCheckedChange={(v) => setSaveProfile(!!v)}
                />
                <label htmlFor="save-profile" className="text-xs text-muted-foreground cursor-pointer">
                  Save as default mapping for this distributor
                </label>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={() => setStep(1)}
            >
              ← Back
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-sm text-xs"
              disabled={!mappingComplete}
              onClick={() => setStep(3)}
            >
              Preview →
            </Button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 3: Preview + Commit                                             */}
      {/* ------------------------------------------------------------------ */}
      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="bg-card border border-border rounded-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono font-medium text-foreground">
                    {preview.rowCountTotal.toLocaleString()}
                  </span>{" "}
                  total rows in file
                  {preview.hasProfile && (
                    <>
                      {" · "}
                      <span className="font-mono font-medium text-foreground">
                        {preview.rowCountMatched.toLocaleString()}
                      </span>{" "}
                      matched to tracked brands
                    </>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Snapshot date:{" "}
                  <span className="font-mono text-foreground">{formatDate(snapshotDate)}</span>
                  {" · "}
                  Distributor:{" "}
                  <span className="font-mono text-foreground">
                    {distributors?.find((d) => d.id === distributorId)?.name}
                  </span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-sm text-xs"
                  onClick={() => setStep(2)}
                >
                  ← Mapping
                </Button>
                <Button
                  size="sm"
                  className="h-7 rounded-sm text-xs"
                  disabled={commitMutation.isPending}
                  onClick={handleCommit}
                >
                  {commitMutation.isPending ? "Committing…" : "Commit Snapshot"}
                </Button>
              </div>
            </div>

            {commitMutation.isError && (
              <Alert variant="destructive" className="rounded-sm py-2 px-3 mb-3">
                <AlertDescription className="text-xs">
                  {(commitMutation.error as Error)?.message ?? "Commit failed"}
                </AlertDescription>
              </Alert>
            )}

            <p className="text-xs text-muted-foreground mb-2">
              Showing first {Math.min(50, previewRows.length)} preview rows
              {!preview.hasProfile && " — brand filtering applied on commit"}
            </p>

            <div className="overflow-x-auto border border-border rounded-sm">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted border-b border-border">
                    {["VPN", "Brand", "Description", "Sell Price", "SOH", "SOO"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-1.5 text-left font-semibold text-muted-foreground whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr
                      key={i}
                      className={`border-b border-border last:border-0 ${
                        i % 2 === 0 ? "bg-background" : "bg-muted/30"
                      }`}
                    >
                      <td className="px-3 py-1 font-mono whitespace-nowrap">{row.vpn}</td>
                      <td className="px-3 py-1 whitespace-nowrap">{row.brand}</td>
                      <td className="px-3 py-1 max-w-xs truncate" title={row.description}>
                        {row.description}
                      </td>
                      <td className="px-3 py-1 font-mono whitespace-nowrap text-right">
                        {row.sell_price}
                      </td>
                      <td className="px-3 py-1 font-mono text-right">{row.soh}</td>
                      <td className="px-3 py-1 font-mono text-right text-muted-foreground">
                        {row.soo || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 4: Done                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === 4 && commitResult && (
        <div className="bg-card border border-border rounded-sm p-8 max-w-md text-center space-y-4">
          <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto" />
          <div>
            <p className="text-sm font-semibold text-foreground">Snapshot committed</p>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="font-mono font-medium text-foreground">
                {commitResult.rowCountMatched.toLocaleString()}
              </span>{" "}
              rows imported for{" "}
              <span className="font-medium text-foreground">{commitResult.distributorName}</span>
              {" — "}
              <span className="font-mono">{formatDate(commitResult.snapshotDate)}</span>
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={handleReset}
            >
              Import Another
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={() => setLocation("/comparison")}
            >
              View Comparison
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
