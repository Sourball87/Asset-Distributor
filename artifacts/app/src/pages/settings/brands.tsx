import { useState } from "react";
import { useListBrands, getListBrandsQueryKey, useCreateBrand, useUpdateBrand, useDeleteBrand } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const brandSchema = z.object({
  canonicalName: z.string().min(1, "Canonical name is required"),
  aliasesString: z.string(), // We'll parse this to string[] before sending
});

type BrandFormValues = z.infer<typeof brandSchema>;

export default function Brands() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: brands = [], isLoading } = useListBrands({
    query: { queryKey: getListBrandsQueryKey() }
  });

  const createBrand = useCreateBrand({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBrandsQueryKey() });
        setIsFormOpen(false);
        form.reset();
        toast({ title: "Brand created" });
      }
    }
  });

  const updateBrand = useUpdateBrand({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBrandsQueryKey() });
        setIsFormOpen(false);
        setEditingId(null);
        form.reset();
        toast({ title: "Brand updated" });
      }
    }
  });

  const deleteBrand = useDeleteBrand({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBrandsQueryKey() });
        toast({ title: "Brand deleted" });
      }
    }
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const form = useForm<BrandFormValues>({
    resolver: zodResolver(brandSchema),
    defaultValues: {
      canonicalName: "",
      aliasesString: "",
    },
  });

  const handleOpenCreate = () => {
    setEditingId(null);
    form.reset({ canonicalName: "", aliasesString: "" });
    setIsFormOpen(true);
  };

  const handleOpenEdit = (brand: any) => {
    setEditingId(brand.id);
    form.reset({
      canonicalName: brand.canonicalName,
      aliasesString: brand.aliases.join(", "),
    });
    setIsFormOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this brand?")) {
      deleteBrand.mutate({ id });
    }
  };

  const onSubmit = (data: BrandFormValues) => {
    const aliases = data.aliasesString.split(",").map(s => s.trim()).filter(Boolean);
    const payload = { canonicalName: data.canonicalName, aliases };

    if (editingId) {
      updateBrand.mutate({ id: editingId, data: payload });
    } else {
      createBrand.mutate({ data: payload });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Manage Brands</h1>
        <Button size="sm" className="h-8 rounded-sm text-xs" onClick={handleOpenCreate}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Brand
        </Button>
      </div>

      <div className="border border-border rounded-sm bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="h-9 hover:bg-transparent">
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider w-[250px]">Canonical Name</TableHead>
              <TableHead className="font-semibold text-xs text-foreground uppercase tracking-wider">Aliases (Variations)</TableHead>
              <TableHead className="text-right font-semibold text-xs text-foreground uppercase tracking-wider w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Loading brands...</TableCell>
              </TableRow>
            ) : brands.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No brands found.</TableCell>
              </TableRow>
            ) : (
              brands.map((brand, idx) => (
                <TableRow key={brand.id} className={`h-10 ${idx % 2 === 0 ? 'bg-background' : 'bg-muted/20'}`}>
                  <TableCell className="font-medium">{brand.canonicalName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {brand.aliases.length > 0 ? brand.aliases.map((a: string) => (
                        <span key={a} className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded-sm text-[10px] uppercase font-mono tracking-tight">
                          {a}
                        </span>
                      )) : <span className="text-muted-foreground/50 text-xs italic">None</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenEdit(brand)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(brand.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
            <DialogTitle>{editingId ? "Edit Brand" : "New Brand"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="canonicalName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Canonical Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Lenovo" {...field} className="h-8 rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="aliasesString"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Aliases</FormLabel>
                    <FormControl>
                      <Textarea placeholder="LENOVO, LENOVO INC, LNV" {...field} className="min-h-[80px] rounded-sm text-sm" />
                    </FormControl>
                    <FormDescription className="text-[10px]">
                      Comma-separated list of spelling variations found in distributor files.
                    </FormDescription>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              <DialogFooter className="pt-4 border-t border-border mt-4">
                <Button type="button" variant="outline" size="sm" onClick={() => setIsFormOpen(false)} className="h-8 rounded-sm text-xs">Cancel</Button>
                <Button type="submit" size="sm" className="h-8 rounded-sm text-xs" disabled={createBrand.isPending || updateBrand.isPending}>
                  {createBrand.isPending || updateBrand.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
