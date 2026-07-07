import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { useLogout, getGetMeQueryKey, useListAdminUsers, getListAdminUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, LayoutDashboard, Grid, Package, Building2, Upload, TrendingUp, FileSliders, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, setUser } = useAuth();
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        setUser(null);
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      }
    }
  });

  const { data: allUsers = [] } = useListAdminUsers({
    query: {
      queryKey: getListAdminUsersQueryKey(),
      enabled: user?.role === "admin",
      refetchInterval: 60_000,
    }
  });

  if (!user) return <>{children}</>;

  const handleLogout = () => {
    logout.mutate();
  };

  const pendingCount = user.role === "admin"
    ? allUsers.filter((u) => u.status === "pending").length
    : 0;

  const isUser = user.role === "user";
  const isAdmin = user.role === "admin";

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/comparison", label: "Comparison", icon: Grid },
    { href: "/insights", label: "Insights", icon: TrendingUp },
    ...(!isUser ? [{ href: "/import", label: "Import", icon: Upload }] : []),
  ];

  const settingsItems = [
    ...(!isUser ? [{ href: "/settings/distributors", label: "Distributors", icon: Building2 }] : []),
    { href: "/settings/brands", label: "Brands", icon: Package },
    ...(!isUser ? [{ href: "/settings/import-profiles", label: "Import Profiles", icon: FileSliders }] : []),
    ...(isAdmin ? [{ href: "/settings/users", label: "Users", icon: Users, badge: pendingCount }] : []),
  ];

  return (
    <div className="flex min-h-[100dvh] w-full bg-background font-sans text-sm">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-card flex flex-col hidden md:flex">
        <div className="h-12 border-b border-border flex items-center px-4 font-bold text-foreground tracking-tight">
          DistiBench
        </div>
        <div className="flex-1 overflow-auto py-2">
          <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Menu
          </div>
          <nav className="space-y-0.5 px-2">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className={`flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors ${location === item.href ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
                <item.icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>

          <Separator className="my-4" />

          <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Settings
          </div>
          <nav className="space-y-0.5 px-2">
            {settingsItems.map((item) => (
              <Link key={item.href} href={item.href} className={`flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors ${location === item.href ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
                <item.icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {'badge' in item && item.badge != null && item.badge > 0 && (
                  <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-sm bg-destructive text-destructive-foreground text-[10px] font-bold font-mono">
                    {item.badge}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-12 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
          <div className="md:hidden font-bold tracking-tight">DistiBench</div>
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground text-xs">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={handleLogout} disabled={logout.isPending} className="h-8 px-2 text-muted-foreground hover:text-foreground">
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto p-4 bg-muted/30">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
