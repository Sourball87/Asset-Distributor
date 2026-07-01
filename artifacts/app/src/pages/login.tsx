import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Terminal } from "lucide-react";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { setUser } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const login = useLogin({
    mutation: {
      onSuccess: (user) => {
        setUser(user);
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/");
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error;
        setError(msg ?? "Login failed");
      },
    },
  });

  const onSubmit = (data: LoginFormValues) => {
    setError(null);
    login.mutate({ data });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4 font-sans text-sm">
      <Card className="w-full max-w-sm border-border shadow-md rounded-sm">
        <CardHeader className="space-y-1 text-center pb-6">
          <div className="flex justify-center mb-4">
            <div className="bg-primary text-primary-foreground p-2 rounded-sm">
              <Terminal className="h-6 w-6" />
            </div>
          </div>
          <CardTitle className="text-xl tracking-tight">DistiBench</CardTitle>
          <CardDescription className="text-xs">
            Distributor Pricing & Stock Comparison
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {error && (
                <Alert variant="destructive" className="rounded-sm py-2 px-3">
                  <AlertDescription className="text-xs">{error}</AlertDescription>
                </Alert>
              )}
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">Email</FormLabel>
                    <FormControl>
                      <Input placeholder="admin@dickerdata.com.au" {...field} className="h-8 text-sm rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="••••••••" {...field} className="h-8 text-sm rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full h-8 rounded-sm text-xs font-semibold mt-2" disabled={login.isPending}>
                {login.isPending ? "Authenticating..." : "Sign In"}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 border-t border-border pt-4 bg-muted/20">
          <div className="text-xs text-muted-foreground text-center">
            Demo credentials:<br/>
            <span className="font-mono text-foreground">admin@dickerdata.com.au</span> / <span className="font-mono text-foreground">admin</span>
          </div>
          <div className="text-xs text-center">
            <Link href="/request-access" className="text-muted-foreground hover:text-foreground underline">
              Request access
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
