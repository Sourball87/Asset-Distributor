import { useState } from "react";
import {
  useListAdminUsers,
  getListAdminUsersQueryKey,
  useUpdateAdminUser,
  useDeleteAdminUser,
} from "@workspace/api-client-react";
import type { AdminUser } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, CheckCircle, XCircle } from "lucide-react";
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
                    <TableCell className="font-mono text-xs">{format(new Date(u.createdAt), "dd.MM.yyyy")}</TableCell>
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
                <TableHead className="text-right font-semibold text-xs text-foreground uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">Loading...</TableCell>
                </TableRow>
              ) : active.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">No active users.</TableCell>
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
                    <TableCell className="font-mono text-xs">{format(new Date(u.createdAt), "dd.MM.yyyy")}</TableCell>
                    <TableCell className="text-right">
                      {u.id !== currentUser?.id && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleRemove(u)}
                          disabled={deleteUser.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
