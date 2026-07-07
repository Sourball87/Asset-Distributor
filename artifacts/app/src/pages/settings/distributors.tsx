import { useState } from "react";
import { useListDistributors, getListDistributorsQueryKey, useCreateDistributor, useUpdateDistributor, useDeleteDistributor, useDeleteDistributorUploads } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/date";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { Plus, Pencil, Trash2, CheckCircle2, DatabaseZap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";

const distributorSchema = z.object({
  name: z.string().min(1, "Name is required"),
  isBaseline: z.boolean().default(false),
  stalenessThresholdDays: z.coerce.number().min(1).default(2),
});

type DistributorFormValues = z.infer<typeof distributorSchema>;

export default function Distributors() {
  const { user } = useAuth();
  const canEdit = user?.role !== "user";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: distributors = [], isLoading } = useListDistributors({
    query: { queryKey: getListDistributorsQueryKey() }
  });

  const createDistributor = useCreateDistributor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDistributorsQueryKey() });
        setIsFormOpen(false);
        form.reset();
        toast({ title: "Distributor created", description: "The distributor has been added successfully." });
      }
    }
  });

  const updateDistributor = useUpdateDistributor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDistributorsQueryKey() });
        setIsFormOpen(false);
        setEditingId(null);
        form.reset();
        toast({ title: "Distributor updated", description: "Changes saved successfully." });
      }
    }
  });

  const deleteDistributor = useDeleteDistributor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDistributorsQueryKey() });
        toast({ title: "Distributor deleted" });
      },
      onError: (err: any) => {
        const message = err?.response?.data?.error ?? err?.message ?? "Failed to delete distributor";
        toast({ title: "Cannot delete distributor", description: message, variant: "destructive" });
      }
    }
  });

  const deleteDistributorUploads = useDeleteDistributorUploads({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDistributorsQueryKey() });
        setClearUploadsTarget(null);
        toast({ title: "Uploads cleared", description: "All upload history has been removed." });
      },
      onError: (err: any) => {
        const message = err?.response?.data?.error ?? err?.message ?? "Failed to clear uploads";
        toast({ title: "Error", description: message, variant: "destructive" });
      }
    }
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [clearUploadsTarget, setClearUploadsTarget] = useState<{ id: number; name: string } | null>(null);

  const form = useForm<DistributorFormValues>({
    resolver: zodResolver(distributorSchema),
    defaultValues: {
      name: "",
      isBaseline: false,
      stalenessThresholdDays: 2,
    },
  });

  const handleOpenCreate = () => {
    setEditingId(null);
    form.reset({ name: "", isBaseline: false, stalenessThresholdDays: 2 });
    setIsFormOpen(true);
  };

  const handleOpenEdit = (dist: any) => {
    setEditingId(dist.id);
    form.reset({
      name: dist.name,
      isBaseline: dist.isBaseline,
      stalenessThresholdDays: dist.stalenessThresholdDays,
    });
    setIsFormOpen(true);
  };

  const handleSetBaseline = (id: number) => {
    updateDistributor.mutate({ id, data: { isBaseline: true } });
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this distributor?")) {
      deleteDistributor.mutate({ id });
    }
  };

  const handleConfirmClearUploads = () => {
    if (!clearUploadsTarget) return;
    deleteDistributorUploads.mutate({ id: clearUploadsTarget.id });
  };

  const onSubmit = (data: DistributorFormValues) => {
    if (editingId) {
      updateDistributor.mutate({ id: editingId, data });
    } else {
      createDistributor.mutate({ data });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Manage Distributors</h1>
        {canEdit && (
          <Button size="sm" className="h-8 rounded-sm text-xs" onClick={handleOpenCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Distributor
          </Button>
        )}
      </div>

      <div className="border border-border rounded-sm bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="h-9 hover:bg-transparent">
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider w-[250px]">Name</TableHead>
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider w-[150px]">Role</TableHead>
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Stale Threshold</TableHead>
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Last Upload</TableHead>
              <TableHead className="text-right font-semibold text-xs text-foreground uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading distributors...</TableCell>
              </TableRow>
            ) : distributors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No distributors found.</TableCell>
              </TableRow>
            ) : (
              distributors.map((dist, idx) => (
                <TableRow key={dist.id} className={`h-10 ${idx % 2 === 0 ? 'bg-background' : 'bg-muted/20'}`}>
                  <TableCell className="font-medium">{dist.name}</TableCell>
                  <TableCell>
                    {dist.isBaseline ? (
                      <span className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold">
                        <CheckCircle2 className="h-3 w-3" /> Baseline
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Competitor</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{dist.stalenessThresholdDays} days</TableCell>
                  <TableCell className="font-mono text-xs">
                    {formatDate(dist.lastUploadAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <div className="flex justify-end items-center gap-2">
                        {!dist.isBaseline && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleSetBaseline(dist.id)}>
                            Set Baseline
                          </Button>
                        )}
                        {dist.lastUploadAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setClearUploadsTarget({ id: dist.id, name: dist.name })}
                            title="Delete all uploads for this distributor"
                          >
                            <DatabaseZap className="h-3.5 w-3.5 mr-1" />
                            Clear uploads
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenEdit(dist)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(dist.id)}>
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

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-[425px] rounded-sm">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Distributor" : "New Distributor"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Distributor Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Dicker Data" {...field} className="h-8 rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="stalenessThresholdDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Staleness Threshold (Days)</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} {...field} className="h-8 rounded-sm font-mono" />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Number of days before stock data is considered stale.
                    </FormDescription>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isBaseline"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-sm border border-border p-3 shadow-sm bg-muted/20">
                    <div className="space-y-0.5">
                      <FormLabel className="text-xs">Baseline Distributor</FormLabel>
                      <FormDescription className="text-[10px]">
                        Compare all other distributors against this one.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <DialogFooter className="pt-4 border-t border-border mt-4">
                <Button type="button" variant="outline" size="sm" onClick={() => setIsFormOpen(false)} className="h-8 rounded-sm text-xs">Cancel</Button>
                <Button type="submit" size="sm" className="h-8 rounded-sm text-xs" disabled={createDistributor.isPending || updateDistributor.isPending}>
                  {createDistributor.isPending || updateDistributor.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!clearUploadsTarget} onOpenChange={(open) => { if (!open) setClearUploadsTarget(null); }}>
        <DialogContent className="sm:max-w-[420px] rounded-sm">
          <DialogHeader>
            <DialogTitle>Delete all uploads</DialogTitle>
            <DialogDescription className="text-xs pt-1">
              This will permanently delete all upload history and snapshot data for{" "}
              <span className="font-semibold text-foreground">{clearUploadsTarget?.name}</span>.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-4 border-t border-border mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={() => setClearUploadsTarget(null)}
              disabled={deleteDistributorUploads.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-8 rounded-sm text-xs"
              onClick={handleConfirmClearUploads}
              disabled={deleteDistributorUploads.isPending}
            >
              {deleteDistributorUploads.isPending ? "Deleting..." : "Delete all uploads"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
