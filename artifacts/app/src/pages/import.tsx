import { useState, useRef, useCallback, useId } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDistributors,
  getListUploadsQueryKey,
  CommitUploadInputSourceFormat,
  type ParsePreview,
  type ColumnMapping,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileUp, CheckCircle2, AlertCircle, Loader2, X } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileStatus = "queued" | "parsing" | "ready" | "importing" | "done" | "error";

interface FileEntry {
  id: string;
  file: File;
  status: FileStatus;
  error?: string;
  // parse result
  tempFileKey?: string;
  columns?: string[];
  mapping?: ColumnMapping;
  detectedDistributorId?: number | null;
  detectedDistributorName?: string | null;
  rowCountTotal?: number;
  rowCountMatched?: number;
  detectedDelimiter?: string | null;
  hasProfile?: boolean;
  profileHeaderRowIndex?: number;
  // override
  overrideDistributorId?: number | null;
  // result
  committedCount?: number;
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function fileSourceFormat(filename: string): (typeof CommitUploadInputSourceFormat)[keyof typeof CommitUploadInputSourceFormat] {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx" || ext === "xls") return CommitUploadInputSourceFormat.xlsx;
  return CommitUploadInputSourceFormat.txt;
}

function delimiterParam(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw === "\t") return "tab";
  if (raw === "|") return "pipe";
  return raw;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function parseFile(file: File): Promise<ParsePreview> {
  const fd = new FormData();
  fd.append("file", file);
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
}

async function commitFile(entry: FileEntry, snapshotDate: string): Promise<{ rowCountMatched: number }> {
  const distributorId = entry.overrideDistributorId ?? entry.detectedDistributorId;
  if (!distributorId || !entry.tempFileKey || !entry.mapping) {
    throw new Error("Missing required fields for commit");
  }
  const body = {
    distributorId,
    tempFileKey: entry.tempFileKey,
    mapping: entry.mapping,
    sourceFormat: fileSourceFormat(entry.file.name),
    delimiter: delimiterParam(entry.detectedDelimiter),
    headerRowIndex: entry.profileHeaderRowIndex ?? 0,
    snapshotDate,
    saveProfile: !entry.hasProfile,
  };
  const res = await fetch("/api/uploads/commit", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? "Commit failed");
  }
  const data = await res.json();
  return { rowCountMatched: data.rowCountMatched };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ImportPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [snapshotDate] = useState(todayIso());
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { data: distributors } = useListDistributors();
  const dropZoneId = useId();

  // --------------------------------------------------------------------------
  // File state helpers
  // --------------------------------------------------------------------------

  function updateFile(id: string, patch: Partial<FileEntry>) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // --------------------------------------------------------------------------
  // Parse a single file immediately after drop
  // --------------------------------------------------------------------------

  const triggerParse = useCallback(async (entry: FileEntry) => {
    updateFile(entry.id, { status: "parsing" });
    try {
      const preview = await parseFile(entry.file);
      const mapping: ColumnMapping =
        preview.detectedMapping ??
        (preview.profile?.mapping as ColumnMapping) ??
        { vpn: "", brand: "", description: "", sell_price: "", soh: "", soo: null };

      updateFile(entry.id, {
        status: "ready",
        tempFileKey: preview.tempFileKey,
        columns: preview.columns,
        mapping,
        detectedDistributorId: preview.detectedDistributorId ?? null,
        detectedDistributorName: preview.detectedDistributorName ?? null,
        rowCountTotal: preview.rowCountTotal,
        rowCountMatched: preview.rowCountMatched,
        detectedDelimiter: preview.detectedDelimiter ?? null,
        hasProfile: preview.hasProfile,
        profileHeaderRowIndex: preview.profile?.headerRowIndex ?? 0,
      });
    } catch (e: unknown) {
      updateFile(entry.id, {
        status: "error",
        error: e instanceof Error ? e.message : "Parse failed",
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function acceptFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming);
    const newEntries: FileEntry[] = arr
      .filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return ["xlsx", "xls", "csv", "txt"].includes(ext);
      })
      .map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: f,
        status: "queued" as FileStatus,
      }));

    setFiles((prev) => [...prev, ...newEntries]);

    for (const entry of newEntries) {
      triggerParse(entry);
    }
  }

  // --------------------------------------------------------------------------
  // Import a single file
  // --------------------------------------------------------------------------

  async function importOne(id: string) {
    const entry = files.find((f) => f.id === id);
    if (!entry || entry.status !== "ready") return;

    updateFile(id, { status: "importing" });
    try {
      const result = await commitFile(entry, snapshotDate);
      updateFile(id, { status: "done", committedCount: result.rowCountMatched });
      queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
    } catch (e: unknown) {
      updateFile(id, {
        status: "error",
        error: e instanceof Error ? e.message : "Import failed",
      });
    }
  }

  // --------------------------------------------------------------------------
  // Import all ready files
  // --------------------------------------------------------------------------

  async function importAll() {
    const ready = files.filter((f) => f.status === "ready");
    await Promise.all(ready.map((f) => importOne(f.id)));
  }

  // --------------------------------------------------------------------------
  // Counts
  // --------------------------------------------------------------------------

  const readyCount = files.filter((f) => f.status === "ready").length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const parsingCount = files.filter((f) => f.status === "parsing" || f.status === "queued").length;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-foreground">Import Snapshots</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Drop one or more distributor files. Distributor and column mapping are detected automatically.
        </p>
      </div>

      {/* Drop zone */}
      <div
        id={dropZoneId}
        className={`border-2 border-dashed rounded-sm p-10 text-center cursor-pointer transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) acceptFiles(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
        role="button"
        aria-label="Drop files here or click to browse"
      >
        <FileUp className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          Drop files here or <span className="text-primary underline">browse</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          .xlsx · .csv · .txt — multiple files supported · up to 50 MB each
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,.txt"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              acceptFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
      </div>

      {/* File queue */}
      {files.length > 0 && (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted border-b border-border">
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground">File</th>
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-48">Distributor</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-28">Rows</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-28">Matched</th>
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-32">Status</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {files.map((entry, i) => {
                const effectiveDistributorId =
                  entry.overrideDistributorId !== undefined
                    ? entry.overrideDistributorId
                    : entry.detectedDistributorId;
                const isReady = entry.status === "ready";
                const isParsing = entry.status === "parsing" || entry.status === "queued";
                const isDone = entry.status === "done";
                const isError = entry.status === "error";
                const isImporting = entry.status === "importing";

                return (
                  <tr
                    key={entry.id}
                    className={`border-b border-border last:border-0 ${
                      i % 2 === 0 ? "bg-background" : "bg-muted/20"
                    }`}
                  >
                    {/* Filename */}
                    <td className="px-3 py-2">
                      <span className="font-mono text-foreground">{entry.file.name}</span>
                      <span className="ml-2 text-muted-foreground">
                        ({(entry.file.size / 1024).toFixed(0)} KB)
                      </span>
                    </td>

                    {/* Distributor — auto-detected or override dropdown */}
                    <td className="px-3 py-2">
                      {isParsing ? (
                        <span className="text-muted-foreground italic">detecting…</span>
                      ) : isReady || isImporting ? (
                        <Select
                          value={String(effectiveDistributorId ?? "")}
                          onValueChange={(v) =>
                            updateFile(entry.id, { overrideDistributorId: v ? Number(v) : null })
                          }
                        >
                          <SelectTrigger
                            className={`h-6 text-xs rounded-sm border-0 bg-transparent p-0 focus:ring-0 shadow-none w-full ${
                              !effectiveDistributorId ? "text-destructive" : ""
                            }`}
                          >
                            <SelectValue
                              placeholder={
                                entry.detectedDistributorName
                                  ? `${entry.detectedDistributorName} (detected)`
                                  : "— select distributor —"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {(distributors ?? []).map((d) => (
                              <SelectItem key={d.id} value={String(d.id)} className="text-xs">
                                {d.name}
                                {d.isBaseline && (
                                  <span className="ml-1 text-muted-foreground">(baseline)</span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : isDone ? (
                        <span className="text-muted-foreground">
                          {distributors?.find((d) => d.id === effectiveDistributorId)?.name ??
                            entry.detectedDistributorName ??
                            "—"}
                        </span>
                      ) : isError ? (
                        <span className="text-muted-foreground">—</span>
                      ) : null}
                    </td>

                    {/* Total rows */}
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {isParsing ? (
                        <span className="text-muted-foreground">—</span>
                      ) : entry.rowCountTotal != null ? (
                        entry.rowCountTotal.toLocaleString()
                      ) : (
                        "—"
                      )}
                    </td>

                    {/* Matched rows */}
                    <td className="px-3 py-2 text-right font-mono">
                      {isDone ? (
                        <span className="text-foreground font-medium">
                          {entry.committedCount?.toLocaleString() ?? "—"}
                        </span>
                      ) : isReady || isImporting ? (
                        <span className="text-muted-foreground">
                          {entry.rowCountMatched?.toLocaleString() ?? "—"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-3 py-2">
                      {isParsing && (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Parsing…
                        </span>
                      )}
                      {isReady && !effectiveDistributorId && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Select disti
                        </span>
                      )}
                      {isReady && !!effectiveDistributorId && (
                        <span className="text-muted-foreground">Ready</span>
                      )}
                      {isImporting && (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Importing…
                        </span>
                      )}
                      {isDone && (
                        <span className="flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {entry.committedCount?.toLocaleString()} committed
                        </span>
                      )}
                      {isError && (
                        <span className="flex items-center gap-1 text-destructive" title={entry.error}>
                          <AlertCircle className="h-3.5 w-3.5" />
                          Error
                        </span>
                      )}
                    </td>

                    {/* Remove */}
                    <td className="px-2 py-2 text-center">
                      {!isImporting && (
                        <button
                          onClick={() => removeFile(entry.id)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          aria-label="Remove"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Error details for failed files */}
      {files.some((f) => f.status === "error") && (
        <div className="space-y-1.5">
          {files
            .filter((f) => f.status === "error" && f.error)
            .map((f) => (
              <Alert key={f.id} variant="destructive" className="rounded-sm py-2 px-3">
                <AlertDescription className="text-xs">
                  <span className="font-mono font-medium">{f.file.name}:</span> {f.error}
                </AlertDescription>
              </Alert>
            ))}
        </div>
      )}

      {/* Bottom action bar */}
      {files.length > 0 && (
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="text-xs text-muted-foreground space-x-3">
            <span>Snapshot date: <span className="font-mono text-foreground">{formatDate(snapshotDate)}</span></span>
            {parsingCount > 0 && <span>{parsingCount} detecting…</span>}
            {doneCount > 0 && <span className="text-emerald-700">{doneCount} imported</span>}
            {errorCount > 0 && <span className="text-destructive">{errorCount} failed</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={() => setFiles([])}
            >
              Clear All
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-sm text-xs"
              disabled={readyCount === 0 || files.some((f) => f.status === "importing")}
              onClick={importAll}
            >
              {files.some((f) => f.status === "importing")
                ? "Importing…"
                : `Import ${readyCount} file${readyCount !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
