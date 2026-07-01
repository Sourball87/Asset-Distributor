import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForgotPassword } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Terminal } from "lucide-react";

const schema = z.object({
  email: z.string().email("Invalid email address"),
});

type FormValues = z.infer<typeof schema>;

export default function ForgotPassword() {
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const forgotPassword = useForgotPassword({
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
    setError(null);
    forgotPassword.mutate({ data });
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
          <CardTitle className="text-xl tracking-tight">Reset Password</CardTitle>
          <CardDescription className="text-xs">
            Enter your email address to receive a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <Alert className="rounded-sm py-2 px-3 bg-muted border-border">
              <AlertDescription className="text-xs">
                If that email address is registered, you will receive a password reset link shortly.
                Check your inbox and spam folder.
              </AlertDescription>
            </Alert>
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
                  name="email"
                  render={({ field }) => (
                    <FormItem className="space-y-1">
                      <FormLabel className="text-xs">Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="you@example.com"
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
                  disabled={forgotPassword.isPending}
                >
                  {forgotPassword.isPending ? "Sending..." : "Send Reset Link"}
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3 border-t border-border pt-4 bg-muted/20">
          <div className="text-xs text-center">
            <Link href="/login" className="text-muted-foreground hover:text-foreground underline">
              Back to sign in
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
