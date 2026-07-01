import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useResetPassword } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Terminal } from "lucide-react";

const schema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type FormValues = z.infer<typeof schema>;

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [token, setToken] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (!t) {
      setError("Missing or invalid reset link. Please request a new one.");
    } else {
      setToken(t);
    }
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const resetPassword = useResetPassword({
    mutation: {
      onSuccess: () => {
        setSuccess(true);
        setError(null);
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error;
        setError(msg ?? "An error occurred. Please try again.");
      },
    },
  });

  const onSubmit = (data: FormValues) => {
    if (!token) return;
    setError(null);
    resetPassword.mutate({ data: { token, password: data.password } });
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
          <CardTitle className="text-xl tracking-tight">Set New Password</CardTitle>
          <CardDescription className="text-xs">
            Choose a new password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="space-y-4">
              <Alert className="rounded-sm py-2 px-3 bg-muted border-border">
                <AlertDescription className="text-xs">
                  Your password has been updated successfully.
                </AlertDescription>
              </Alert>
              <Button
                className="w-full h-8 rounded-sm text-xs font-semibold"
                onClick={() => setLocation("/login")}
              >
                Sign In
              </Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {error && (
                  <Alert variant="destructive" className="rounded-sm py-2 px-3">
                    <AlertDescription className="text-xs">{error}</AlertDescription>
                  </Alert>
                )}
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem className="space-y-1">
                      <FormLabel className="text-xs">New Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="••••••••"
                          {...field}
                          className="h-8 text-sm rounded-sm"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem className="space-y-1">
                      <FormLabel className="text-xs">Confirm Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="••••••••"
                          {...field}
                          className="h-8 text-sm rounded-sm"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full h-8 rounded-sm text-xs font-semibold mt-2"
                  disabled={resetPassword.isPending || !token}
                >
                  {resetPassword.isPending ? "Updating..." : "Set New Password"}
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3 border-t border-border pt-4 bg-muted/20">
          <div className="text-xs text-center">
            <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground underline">
              Request a new reset link
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
