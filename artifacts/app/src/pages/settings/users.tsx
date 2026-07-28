import { useState } from "react";
import {
  useListAdminUsers,
  getListAdminUsersQueryKey,
  useUpdateAdminUser,
  useDeleteAdminUser,
  useResetAdminUserPassword,
} from "@workspace/api-client-react";
import type { AdminUser } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/date";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Trash2, CheckCircle, XCircle, KeyRound, Copy, Check, Loader2, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  superuser: "Superuser",
  user: "User",
};

export default function UsersSettings() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [resetResult, setResetResult] = useState<{ user: AdminUser; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: users = [], isLoading } = useListAdminUsers({
    query: { queryKey: getListAdminUsersQueryKey() },
  });

  const updateUser = useUpdateAdminUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        toast({ title: "User updated" });
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error ?? "Update failed";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const deleteUser = useDeleteAdminUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        toast({ title: "User removed" });
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error ?? "Delete failed";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const resetPassword = useResetAdminUserPassword({
    mutation: {
      onSuccess: (data, variables) => {
        const targetUser = users.find((u) => u.id === variables.id);
        if (targetUser) {
          setResetResult({ user: targetUser, password: data.temporaryPassword });
        }
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error ?? "Password reset failed";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const handleApprove = (u: AdminUser) => {
    updateUser.mutate({ id: u.id, data: { status: "active" } });
  };

  const handleDeny = (u: AdminUser) => {
    if (confirm(`Deny access for ${u.email}? This will remove their pending account.`)) {
      deleteUser.mutate({ id: u.id });
    }
  };

  const handleRoleChange = (u: AdminUser, role: string) => {
    updateUser.mutate({ id: u.id, data: { role: role as "admin" | "superuser" | "user" } });
  };

  const handleRemove = (u: AdminUser) => {
    if (confirm(`Remove ${u.email}? This cannot be undone.`)) {
      deleteUser.mutate({ id: u.id });
    }
  };

  const handleResetPassword = (u: AdminUser) => {
    if (confirm(`Reset password for ${u.email}? A temporary password will be generated.`)) {
      resetPassword.mutate({ id: u.id });
    }
  };

  const handleCopy = () => {
    if (!resetResult) return;
    navigator.clipboard.writeText(resetResult.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCloseDialog = () => {
    setResetResult(null);
    setCopied(false);
  };

  const pending = users.filter((u) => u.status === "pending");
  const active = users.filter((u) => u.status === "active");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold tracking-tight">User Management</h1>

      {/* Pending requests */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Pending Requests
          </h2>
          {pending.length > 0 && (
            <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-sm bg-destructive text-destructive-foreground text-[10px] font-bold font-mono">
              {pending.length}
            </span>
          )}
        </div>
        <div className="border border-border rounded-sm bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="h-9 hover:bg-transparent">
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Name</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Email</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Requested</TableHead>
                <TableHead className="text-right font-semibold text-xs text-foreground uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-6 text-muted-foreground text-xs">Loading...</TableCell>
                </TableRow>
              ) : pending.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-6 text-muted-foreground text-xs">No pending requests.</TableCell>
                </TableRow>
              ) : (
                pending.map((u, idx) => (
                  <TableRow key={u.id} className={`h-10 ${idx % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <TableCell className="font-medium text-xs">{u.name}</TableCell>
                    <TableCell className="font-mono text-xs">{u.email}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-green-700 hover:text-green-800 hover:bg-green-50"
                          onClick={() => handleApprove(u)}
                          disabled={updateUser.isPending}
                        >
                          <CheckCircle className="h-3.5 w-3.5 mr-1" />
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeny(u)}
                          disabled={deleteUser.isPending}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Deny
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Active users */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Active Users
        </h2>
        <div className="border border-border rounded-sm bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="h-9 hover:bg-transparent">
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Name</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Email</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider w-[150px]">Role</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Created</TableHead>
                <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Last Login</TableHead>
                <TableHead className="text-right font-semibold text-xs text-foreground uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">Loading...</TableCell>
                </TableRow>
              ) : active.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">No active users.</TableCell>
                </TableRow>
              ) : (
                active.map((u, idx) => (
                  <TableRow key={u.id} className={`h-10 ${idx % 2 === 0 ? "bg-background" : "bg-muted/20"}`}>
                    <TableCell className="font-medium text-xs">{u.name}</TableCell>
                    <TableCell className="font-mono text-xs">{u.email}</TableCell>
                    <TableCell>
                      {u.id === currentUser?.id ? (
                        <span className="text-xs font-mono text-muted-foreground">{ROLE_LABELS[u.role] ?? u.role} (you)</span>
                      ) : (
                        <Select
                          value={u.role}
                          onValueChange={(val) => handleRoleChange(u, val)}
                          disabled={updateUser.isPending}
                        >
                          <SelectTrigger className="h-7 text-xs rounded-sm w-[120px] font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin" className="text-xs font-mono">Admin</SelectItem>
                            <SelectItem value="superuser" className="text-xs font-mono">Superuser</SelectItem>
                            <SelectItem value="user" className="text-xs font-mono">User</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{u.lastLoginAt ? formatDate(u.lastLoginAt) : <span className="italic">never</span>}</TableCell>
                    <TableCell className="text-right">
                      {u.id !== currentUser?.id && (
                        <div className="flex justify-end items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Reset password"
                            onClick={() => handleResetPassword(u)}
                            disabled={resetPassword.isPending}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleRemove(u)}
                            disabled={deleteUser.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Database Maintenance (admin only) */}
      <DatabaseMaintenance />

      {/* Reset password result dialog */}
      <Dialog open={!!resetResult} onOpenChange={(open) => { if (!open) handleCloseDialog(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Password Reset</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              A temporary password has been set for <span className="font-mono font-medium text-foreground">{resetResult?.user.email}</span>. Pass this to the user — it will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-2">
            <span className="flex-1 font-mono text-sm tracking-widest select-all">{resetResult?.password}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={handleCopy}
              title="Copy to clipboard"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <DialogFooter>
            <Button size="sm" className="text-xs h-7" onClick={handleCloseDialog}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Database Maintenance ─────────────────────────────────────────────────────
// Admin-only section for purging invalid uploads from the database.
// Uses plain fetch (not the generated client) since this is a one-off operation.

type PurgePreview = {
  uploadId: number;
  snapshotDate: string;
  currentStatus: string;
  rowCountTotal: number;
  rowCountMatched: number;
  snapshotsToDelete: number;
  orphanProductsToDelete: number;
};

type PurgeResult = {
  deletedSnapshots: number;
  deletedOrphanProducts: number;
  uploadMarkedInvalid: boolean;
};

type PurgeResponse =
  | { dryRun: true;  preflight: PurgePreview }
  | { dryRun: false; preflight: PurgePreview; result: PurgeResult }
  | { error: string };

function DatabaseMaintenance() {
  const [uploadId, setUploadId]         = useState("");
  const [loading, setLoading]           = useState(false);
  const [response, setResponse]         = useState<PurgeResponse | null>(null);
  const [confirming, setConfirming]     = useState(false);

  async function call(dryRun: boolean) {
    const id = uploadId.trim();
    if (!id || isNaN(Number(id))) return;
    setLoading(true);
    setResponse(null);
    setConfirming(false);
    try {
      const resp = await fetch("/api/admin/maintenance/purge-upload", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: Number(id), dryRun }),
      });
      const json: PurgeResponse = await resp.json();
      setResponse(json);
    } catch {
      setResponse({ error: "Network error — check console" });
    } finally {
      setLoading(false);
    }
  }

  const preview = response && !("error" in response) ? response.preflight : null;

  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        Database Maintenance
      </h2>
      <div className="border border-border rounded-sm bg-card p-4 space-y-4">
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-sm px-3 py-2">
          <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>Purge upload</strong> — deletes all stock snapshots for an upload, removes orphaned
            products, and marks the upload <code>invalid_mapping</code>. Use Dry Run first.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={uploadId}
            onChange={(e) => { setUploadId(e.target.value); setResponse(null); setConfirming(false); }}
            placeholder="Upload ID"
            className="w-36 h-8 text-xs font-mono rounded-sm"
            type="number"
            min={1}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs rounded-sm"
            onClick={() => call(true)}
            disabled={loading || !uploadId}
          >
            {loading && !confirming ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Dry Run
          </Button>
          {preview && !confirming && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs rounded-sm"
              onClick={() => setConfirming(true)}
            >
              Confirm Purge…
            </Button>
          )}
          {confirming && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs rounded-sm animate-pulse"
              onClick={() => call(false)}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Yes, purge upload {uploadId}
            </Button>
          )}
        </div>

        {/* Results */}
        {response && "error" in response && (
          <p className="text-xs text-red-600 font-mono">{response.error}</p>
        )}
        {preview && (
          <div className="rounded-sm border border-border bg-muted/30 p-3 text-xs font-mono space-y-1">
            <p className="font-semibold text-foreground mb-1">
              {response && "result" in response ? "✅ Purge committed" : "🔎 Dry run preview"}
            </p>
            <p>Upload ID: <span className="text-foreground">{preview.uploadId}</span></p>
            <p>Snapshot date: <span className="text-foreground">{preview.snapshotDate}</span></p>
            <p>Current status: <span className="text-foreground">{preview.currentStatus}</span></p>
            <p>Snapshots to delete: <span className="text-red-600 font-semibold">{preview.snapshotsToDelete.toLocaleString()}</span></p>
            <p>Orphan products to delete: <span className="text-red-600 font-semibold">{preview.orphanProductsToDelete.toLocaleString()}</span></p>
            {response && "result" in response && (
              <>
                <hr className="border-border my-1" />
                <p>Snapshots deleted: <span className="text-foreground">{response.result.deletedSnapshots?.toLocaleString()}</span></p>
                <p>Products deleted: <span className="text-foreground">{response.result.deletedOrphanProducts?.toLocaleString()}</span></p>
                <p>Upload marked invalid: <span className="text-foreground">{response.result.uploadMarkedInvalid ? "yes" : "no"}</span></p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
