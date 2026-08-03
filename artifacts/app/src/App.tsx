import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { Layout } from "@/components/layout";
import { useEffect } from "react";

// Pages
import Login from "@/pages/login";
import RequestAccess from "@/pages/request-access";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import Dashboard from "@/pages/dashboard";
import Comparison from "@/pages/comparison";
import Insights from "@/pages/insights";
import ImportPage from "@/pages/import";
import Distributors from "@/pages/settings/distributors";
import Brands from "@/pages/settings/brands";
import ImportProfiles from "@/pages/settings/import-profiles";
import UsersSettings from "@/pages/settings/users";
import Movement from "@/pages/movement";
import MarketPrice from "@/pages/market-price";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

// Protected Route wrapper
function ProtectedRoute({ component: Component, ...rest }: any) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    }
  }, [user, isLoading, setLocation]);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-sm font-mono">Loading...</div>;
  }

  if (!user) return null;

  return <Component {...rest} />;
}

// Admin-only route wrapper
function AdminRoute({ component: Component, ...rest }: any) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && (!user || user.role !== "admin")) {
      setLocation("/");
    }
  }, [user, isLoading, setLocation]);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-sm font-mono">Loading...</div>;
  }

  if (!user || user.role !== "admin") return null;

  return <Component {...rest} />;
}

// Admin or superuser route wrapper
function ElevatedRoute({ component: Component, ...rest }: any) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && (!user || user.role === "user")) {
      setLocation("/");
    }
  }, [user, isLoading, setLocation]);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-sm font-mono">Loading...</div>;
  }

  if (!user || user.role === "user") return null;

  return <Component {...rest} />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/request-access" component={RequestAccess} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      
      <Route path="/">
        {() => (
          <Layout>
            <ProtectedRoute component={Dashboard} />
          </Layout>
        )}
      </Route>

      <Route path="/comparison">
        {() => (
          <Layout>
            <ProtectedRoute component={Comparison} />
          </Layout>
        )}
      </Route>

      <Route path="/insights">
        {() => (
          <Layout>
            <ProtectedRoute component={Insights} />
          </Layout>
        )}
      </Route>

      <Route path="/import">
        {() => (
          <Layout>
            <ProtectedRoute component={ImportPage} />
          </Layout>
        )}
      </Route>

      <Route path="/settings/distributors">
        {() => (
          <Layout>
            <ElevatedRoute component={Distributors} />
          </Layout>
        )}
      </Route>

      <Route path="/settings/brands">
        {() => (
          <Layout>
            <ProtectedRoute component={Brands} />
          </Layout>
        )}
      </Route>

      <Route path="/settings/import-profiles">
        {() => (
          <Layout>
            <ProtectedRoute component={ImportProfiles} />
          </Layout>
        )}
      </Route>

      <Route path="/settings/users">
        {() => (
          <Layout>
            <AdminRoute component={UsersSettings} />
          </Layout>
        )}
      </Route>

      <Route path="/movement">
        {() => (
          <Layout>
            <AdminRoute component={Movement} />
          </Layout>
        )}
      </Route>

      <Route path="/market-price">
        {() => (
          <Layout>
            <MarketPrice />
          </Layout>
        )}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
