# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: access-control.spec.ts >> role change to admin is reflected in nav without re-login
- Location: tests/access-control.spec.ts:193:1

# Error details

```
Error: Admin login failed: 401 {"error":"Invalid email or password"}
```

# Test source

```ts
  1   | /**
  2   |  * E2E tests for the user access request and approval flow.
  3   |  *
  4   |  * Scenarios covered:
  5   |  *  1. Full flow: request access → admin approves → user can log in
  6   |  *  2. Pending user is blocked from logging in with the correct error message
  7   |  *  3. Last-admin safeguard: admin cannot delete or demote themselves when sole admin
  8   |  *  4. Role change is reflected immediately without the user needing to re-login
  9   |  */
  10  | 
  11  | import { test, expect, APIRequestContext, request as makeRequest } from "@playwright/test";
  12  | import { randomBytes } from "crypto";
  13  | 
  14  | const ADMIN_EMAIL = "admin@dickerdata.com.au";
  15  | const ADMIN_PASSWORD = "admin";
  16  | 
  17  | const devDomain = process.env.REPLIT_DEV_DOMAIN;
  18  | const API_BASE = devDomain ? `https://${devDomain}` : "http://localhost:80";
  19  | 
  20  | function uid(): string {
  21  |   return randomBytes(4).toString("hex");
  22  | }
  23  | 
  24  | async function getAdminApi(): Promise<APIRequestContext> {
  25  |   const ctx = await makeRequest.newContext({ baseURL: API_BASE });
  26  |   const res = await ctx.post("/api/auth/login", {
  27  |     data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  28  |   });
  29  |   if (!res.ok()) {
> 30  |     throw new Error(`Admin login failed: ${res.status()} ${await res.text()}`);
      |           ^ Error: Admin login failed: 401 {"error":"Invalid email or password"}
  31  |   }
  32  |   return ctx;
  33  | }
  34  | 
  35  | async function createPendingUser(
  36  |   ctx: APIRequestContext,
  37  |   email: string,
  38  |   password: string,
  39  |   name: string,
  40  | ): Promise<void> {
  41  |   const res = await ctx.post("/api/auth/request-access", {
  42  |     data: { email, password, name },
  43  |   });
  44  |   if (res.status() !== 201) {
  45  |     throw new Error(`request-access failed: ${res.status()} ${await res.text()}`);
  46  |   }
  47  | }
  48  | 
  49  | async function findUserId(adminCtx: APIRequestContext, email: string): Promise<number> {
  50  |   const res = await adminCtx.get("/api/admin/users");
  51  |   if (!res.ok()) {
  52  |     throw new Error(`GET /api/admin/users failed: ${res.status()} ${await res.text()}`);
  53  |   }
  54  |   const users: Array<{ id: number; email: string }> = await res.json();
  55  |   if (!Array.isArray(users)) {
  56  |     throw new Error(`Expected array from /api/admin/users, got: ${JSON.stringify(users)}`);
  57  |   }
  58  |   const u = users.find((u) => u.email === email);
  59  |   if (!u) throw new Error(`User ${email} not found in admin list`);
  60  |   return u.id;
  61  | }
  62  | 
  63  | async function approveUser(adminCtx: APIRequestContext, id: number): Promise<void> {
  64  |   const res = await adminCtx.patch(`/api/admin/users/${id}`, {
  65  |     data: { status: "active" },
  66  |   });
  67  |   if (!res.ok()) {
  68  |     throw new Error(`approve failed: ${res.status()} ${await res.text()}`);
  69  |   }
  70  | }
  71  | 
  72  | async function deleteUser(adminCtx: APIRequestContext, id: number): Promise<void> {
  73  |   await adminCtx.delete(`/api/admin/users/${id}`);
  74  | }
  75  | 
  76  | // ---------------------------------------------------------------------------
  77  | // Test 1: Full request → approve → login flow
  78  | // ---------------------------------------------------------------------------
  79  | test("approved user can log in after admin approves their access request", async ({ page }) => {
  80  |   const email = `e2e-approve-${uid()}@example.com`;
  81  |   const password = "testPass123!";
  82  |   const adminCtx = await getAdminApi();
  83  | 
  84  |   await createPendingUser(adminCtx, email, password, "E2E Approve User");
  85  |   const userId = await findUserId(adminCtx, email);
  86  | 
  87  |   try {
  88  |     // Admin approves via API
  89  |     await approveUser(adminCtx, userId);
  90  | 
  91  |     // Approved user logs in via browser
  92  |     await page.goto("/login");
  93  |     await page.getByLabel(/email/i).fill(email);
  94  |     await page.getByLabel(/password/i).fill(password);
  95  |     await page.getByRole("button", { name: /sign in/i }).click();
  96  | 
  97  |     // Should reach the dashboard (not still on /login)
  98  |     await expect(page).not.toHaveURL(/login/);
  99  |     await expect(page).toHaveURL(/\//);
  100 |   } finally {
  101 |     await deleteUser(adminCtx, userId).catch(() => {});
  102 |     await adminCtx.dispose();
  103 |   }
  104 | });
  105 | 
  106 | // ---------------------------------------------------------------------------
  107 | // Test 2: Pending user is blocked from logging in
  108 | // ---------------------------------------------------------------------------
  109 | test("pending user sees 'awaiting approval' error and cannot log in", async ({ page }) => {
  110 |   const email = `e2e-pending-${uid()}@example.com`;
  111 |   const password = "testPass123!";
  112 |   const adminCtx = await getAdminApi();
  113 | 
  114 |   await createPendingUser(adminCtx, email, password, "E2E Pending User");
  115 |   const userId = await findUserId(adminCtx, email);
  116 | 
  117 |   try {
  118 |     await page.goto("/login");
  119 | 
  120 |     await page.getByLabel(/email/i).fill(email);
  121 |     await page.getByLabel(/password/i).fill(password);
  122 |     await page.getByRole("button", { name: /sign in/i }).click();
  123 | 
  124 |     // Must stay on /login — not redirected to dashboard
  125 |     await expect(page).toHaveURL(/login/);
  126 | 
  127 |     // Must show the "awaiting approval" error message
  128 |     await expect(page.getByText(/awaiting approval/i)).toBeVisible();
  129 |   } finally {
  130 |     await deleteUser(adminCtx, userId).catch(() => {});
```