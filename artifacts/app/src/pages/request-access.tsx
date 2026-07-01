import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useRequestAccess } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Terminal } from "lucide-react";

const requestSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type RequestFormValues = z.infer<typeof requestSchema>;

export default function RequestAccess() {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RequestFormValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const requestAccess = useRequestAccess({
    mutation: {
      onSuccess: () => {
        setSubmitted(true);
      },
      onError: (err) => {
        const msg = (err.data as { error?: string } | null)?.error;
        setError(msg ?? "Request failed. Please try again.");
      },
    },
  });

  const onSubmit = (data: RequestFormValues) => {
    setError(null);
    requestAccess.mutate({ data: { name: data.name, email: data.email, password: data.password } });
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4 font-sans text-sm">
        <Card className="w-full max-w-sm border-border shadow-md rounded-sm">
          <CardHeader className="space-y-1 text-center pb-6">
            <div className="flex justify-center mb-4">
              <div className="bg-primary text-primary-foreground p-2 rounded-sm">
                <Terminal className="h-6 w-6" />
              </div>
            </div>
            <CardTitle className="text-xl tracking-tight">Request Submitted</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              Your access request has been submitted.<br />
              An administrator will review it shortly.<br />
              You will be able to sign in once approved.
            </p>
          </CardContent>
          <CardFooter className="flex flex-col border-t border-border pt-4 bg-muted/20">
            <Link href="/login" className="text-xs text-muted-foreground hover:text-foreground underline">
              Back to login
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4 font-sans text-sm">
      <Card className="w-full max-w-sm border-border shadow-md rounded-sm">
        <CardHeader className="space-y-1 text-center pb-6">
          <div className="flex justify-center mb-4">
            <div className="bg-primary text-primary-foreground p-2 rounded-sm">
              <Terminal className="h-6 w-6" />
            </div>
          </div>
          <CardTitle className="text-xl tracking-tight">Request Access</CardTitle>
          <CardDescription className="text-xs">
            Submit a request for a DistiBench account
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
                name="name"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">Full Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Jane Smith" {...field} className="h-8 text-sm rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="jane@example.com" {...field} className="h-8 text-sm rounded-sm" />
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
                      <Input type="password" placeholder="Min. 8 characters" {...field} className="h-8 text-sm rounded-sm" />
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
                      <Input type="password" placeholder="Repeat password" {...field} className="h-8 text-sm rounded-sm" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full h-8 rounded-sm text-xs font-semibold mt-2"
                disabled={requestAccess.isPending}
              >
                {requestAccess.isPending ? "Submitting..." : "Submit Request"}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="flex flex-col border-t border-border pt-4 bg-muted/20">
          <div className="text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link href="/login" className="text-foreground hover:underline font-medium">
              Sign in
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
