import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { Layout } from "@/components/layout";
import { useEffect } from "react";

// Pages
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Comparison from "@/pages/comparison";
import ImportPage from "@/pages/import";
import Distributors from "@/pages/settings/distributors";
import Brands from "@/pages/settings/brands";
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

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      
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
            <ProtectedRoute component={Distributors} />
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
