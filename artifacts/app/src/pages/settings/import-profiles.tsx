import { useState } from "react";
import {
  useListDistributors,
  useGetImportProfile,
  useSaveImportProfile,
  getGetImportProfileQueryKey,
  type ImportProfile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Per-distributor row — loads profile lazily
// ---------------------------------------------------------------------------

interface ProfileRowProps {
  distributorId: number;
  distributorName: string;
  onEdit: (profile: ImportProfile | null, distributorId: number, distributorName: string) => void;
}

function ProfileRow({ distributorId, distributorName, onEdit }: ProfileRowProps) {
  const { data: profile, isLoading, isError } = useGetImportProfile(distributorId, {
    query: { queryKey: getGetImportProfileQueryKey(distributorId), retry: false },
  });

  const mapping = profile?.mapping as Record<string, string | null> | undefined;

  return (
    <TableRow>
      <TableCell className="font-medium text-xs">{distributorName}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {isLoading ? "…" : isError ? <span className="italic">No profile</span> : (mapping?.vpn ?? "—")}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {isLoading ? "…" : isError ? "—" : (mapping?.sell_price ?? "—")}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {isLoading ? "…" : isError ? "—" : (mapping?.soh ?? "—")}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {isLoading ? "…" : isError ? "—" : (mapping?.brand ?? "—")}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {isLoading ? "…" : isError ? "—" : (profile?.sourceFormat ?? "—")}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => onEdit(profile ?? null, distributorId, distributorName)}
          disabled={isLoading}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

interface EditState {
  distributorId: number;
  distributorName: string;
  sourceFormat: "xlsx" | "txt";
  delimiter: string;
  headerRowIndex: number;
  vpn: string;
  brand: string;
  description: string;
  sell_price: string;
  soh: string;
  soo: string;
}

function defaultEdit(distributorId: number, distributorName: string, profile: ImportProfile | null): EditState {
  const mapping = (profile?.mapping ?? {}) as Record<string, string | null>;
  return {
    distributorId,
    distributorName,
    sourceFormat: (profile?.sourceFormat as "xlsx" | "txt") ?? "txt",
    delimiter: profile?.delimiter ?? ",",
    headerRowIndex: profile?.headerRowIndex ?? 0,
    vpn: (mapping.vpn as string | null | undefined) ?? "",
    brand: (mapping.brand as string | null | undefined) ?? "",
    description: (mapping.description as string | null | undefined) ?? "",
    sell_price: (mapping.sell_price as string | null | undefined) ?? "",
    soh: (mapping.soh as string | null | undefined) ?? "",
    soo: (mapping.soo as string | null | undefined) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ImportProfiles() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: distributors = [], isLoading } = useListDistributors();

  const [editState, setEditState] = useState<EditState | null>(null);
  const [open, setOpen] = useState(false);

  const save = useSaveImportProfile({
    mutation: {
      onSuccess: (_, { id }) => {
        queryClient.invalidateQueries({ queryKey: getGetImportProfileQueryKey(id) });
        setOpen(false);
        setEditState(null);
        toast({ title: "Profile saved", description: "Column mapping updated." });
      },
      onError: () => {
        toast({ title: "Save failed", description: "Could not update the import profile.", variant: "destructive" });
      },
    },
  });

  function openEdit(profile: ImportProfile | null, distributorId: number, distributorName: string) {
    setEditState(defaultEdit(distributorId, distributorName, profile));
    setOpen(true);
  }

  function handleSave() {
    if (!editState) return;
    const { distributorId, sourceFormat, delimiter, headerRowIndex, vpn, brand, description, sell_price, soh, soo } = editState;
    save.mutate({
      id: distributorId,
      data: {
        sourceFormat,
        delimiter: sourceFormat === "xlsx" ? null : (delimiter || null),
        headerRowIndex,
        mapping: {
          vpn: vpn,
          brand: brand,
          description: description,
          sell_price: sell_price,
          soh: soh,
          soo: soo || null,
        },
      },
    });
  }

  function patch(field: keyof EditState, value: string | number) {
    setEditState((prev) => prev ? { ...prev, [field]: value } : prev);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-foreground">Import Profiles</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Saved column mappings applied automatically when a distributor file is recognised.
        </p>
      </div>

      <div className="border border-border rounded-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted">
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">Distributor</TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">VPN column</TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">Sell Price column</TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">SOH column</TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">Brand column</TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground h-8">Format</TableHead>
              <TableHead className="h-8 w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">Loading…</TableCell>
              </TableRow>
            ) : distributors.map((d) => (
              <ProfileRow
                key={d.id}
                distributorId={d.id}
                distributorName={d.name}
                onEdit={openEdit}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Edit dialog */}
      <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) { setOpen(v); if (!v) setEditState(null); } }}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              Edit Profile — {editState?.distributorName}
            </DialogTitle>
          </DialogHeader>

          {editState && (
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                Enter the exact column header names as they appear in the file. Leave a field blank to mark it as not mapped.
              </p>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">VPN column <span className="text-destructive">*</span></label>
                  <Input
                    value={editState.vpn}
                    onChange={(e) => patch("vpn", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="e.g. StockCode"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Brand column <span className="text-destructive">*</span></label>
                  <Input
                    value={editState.brand}
                    onChange={(e) => patch("brand", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="e.g. Vendor"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Sell Price column <span className="text-destructive">*</span></label>
                  <Input
                    value={editState.sell_price}
                    onChange={(e) => patch("sell_price", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="e.g. DealerEx"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">SOH column <span className="text-destructive">*</span></label>
                  <Input
                    value={editState.soh}
                    onChange={(e) => patch("soh", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="e.g. StockAvailable"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Description column</label>
                  <Input
                    value={editState.description}
                    onChange={(e) => patch("description", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="e.g. StockDescription"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">SOO column</label>
                  <Input
                    value={editState.soo}
                    onChange={(e) => patch("soo", e.target.value)}
                    className="h-7 text-xs font-mono rounded-sm"
                    placeholder="optional"
                  />
                </div>
              </div>

              <div className="border-t border-border pt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">File format</label>
                  <Select
                    value={editState.sourceFormat}
                    onValueChange={(v) => patch("sourceFormat", v)}
                  >
                    <SelectTrigger className="h-7 text-xs rounded-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="txt" className="text-xs">CSV / TXT</SelectItem>
                      <SelectItem value="xlsx" className="text-xs">Excel (xlsx)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {editState.sourceFormat !== "xlsx" && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">Delimiter</label>
                    <Select
                      value={editState.delimiter}
                      onValueChange={(v) => patch("delimiter", v)}
                    >
                      <SelectTrigger className="h-7 text-xs rounded-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="," className="text-xs">Comma (,)</SelectItem>
                        <SelectItem value="\t" className="text-xs">Tab</SelectItem>
                        <SelectItem value="|" className="text-xs">Pipe (|)</SelectItem>
                        <SelectItem value=";" className="text-xs">Semicolon (;)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-sm text-xs"
              onClick={() => { setOpen(false); setEditState(null); }}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 rounded-sm text-xs"
              onClick={handleSave}
              disabled={save.isPending || !editState?.vpn || !editState?.brand || !editState?.sell_price || !editState?.soh}
            >
              {save.isPending ? "Saving…" : "Save Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
