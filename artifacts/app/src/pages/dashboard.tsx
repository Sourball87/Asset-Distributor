import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, AlertCircle, CheckCircle2, Clock, Database, ArrowRightLeft, DollarSign } from "lucide-react";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading } = useGetDashboardSummary({
    query: {
      queryKey: getGetDashboardSummaryQueryKey(),
    }
  });

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading dashboard data...</div>;
  }

  if (!summary) {
    return <div className="text-muted-foreground text-sm">No data available.</div>;
  }

  const getFreshnessIcon = (freshness: string) => {
    switch (freshness) {
      case 'fresh': return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case 'stale_warn': return <Clock className="h-4 w-4 text-amber-500" />;
      case 'stale_critical': return <AlertCircle className="h-4 w-4 text-red-500" />;
      default: return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getFreshnessText = (freshness: string) => {
    switch (freshness) {
      case 'fresh': return 'Fresh';
      case 'stale_warn': return 'Warning';
      case 'stale_critical': return 'Critical';
      default: return 'No Data';
    }
  };

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'Never';
    try {
      return format(new Date(dateString), 'dd.MM.yyyy');
    } catch {
      return dateString;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">System Overview</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="rounded-sm border-border shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Products Tracked</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="text-2xl font-mono font-medium">{summary.totalProducts.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card className="rounded-sm border-border shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Dicker Highest Price</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="text-2xl font-mono font-medium text-amber-600">{summary.dickerMostExpensiveCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card className="rounded-sm border-border shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Net Movement (30d)</CardTitle>
            <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className={`text-2xl font-mono font-medium ${summary.totalNetMovement > 0 ? 'text-emerald-600' : summary.totalNetMovement < 0 ? 'text-red-600' : ''}`}>
              {summary.totalNetMovement > 0 ? '+' : ''}{summary.totalNetMovement.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-sm font-bold tracking-tight mb-3">Distributor Freshness</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {summary.distributorCards.map(card => (
            <Card key={card.distributorId} className="rounded-sm border-border shadow-none overflow-hidden">
              <div className="p-3 bg-card border-b border-border flex justify-between items-start">
                <div>
                  <div className="font-semibold flex items-center gap-2">
                    {card.name}
                    {card.isBaseline && (
                      <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold">Baseline</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                    {getFreshnessIcon(card.freshness)}
                    <span className="font-medium">{getFreshnessText(card.freshness)}</span>
                    <span className="text-muted-foreground/50 mx-1">•</span>
                    Last: <span className="font-mono">{formatDate(card.lastUploadAt)}</span>
                  </div>
                </div>
              </div>
              <div className="bg-muted/30 p-2 flex justify-end">
                <Button size="sm" variant="outline" className="h-7 text-xs rounded-sm bg-background">
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload Data
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
