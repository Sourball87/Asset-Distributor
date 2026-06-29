import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Grid } from "lucide-react";

export default function Comparison() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Comparison Grid</h1>
      </div>
      
      <Card className="rounded-sm border-border shadow-none border-dashed bg-muted/10">
        <CardContent className="flex flex-col items-center justify-center py-24 text-center">
          <div className="bg-muted p-4 rounded-full mb-4">
            <Grid className="h-8 w-8 text-muted-foreground" />
          </div>
          <CardTitle className="mb-2">Comparison grid coming in Phase 3</CardTitle>
          <CardDescription>
            The full interactive AG Grid comparison view with cross-distributor matching will be implemented in a future phase.
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  );
}
