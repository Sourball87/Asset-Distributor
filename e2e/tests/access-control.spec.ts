/**
 * E2E tests for the user access request and approval flow.
 *
 * Scenarios covered:
 *  1. Full flow: request access → admin approves → user can log in
 *  2. Pending user is blocked from logging in with the correct error message
 *  3. Last-admin safeguard: admin cannot delete or demote themselves when sole admin
 *  4. Role change is reflected immediately without the user needing to re-login
 */

import { test, expect, APIRequestContext, request as makeRequest } from "@playwright/test";
import { randomBytes } from "crypto";

const ADMIN_EMAIL = "admin@dickerdata.com.au";
const ADMIN_PASSWORD = "admin";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const API_BASE = devDomain ? `https://${devDomain}` : "http://localhost:80";

function uid(): string {
  return randomBytes(4).toString("hex");
}

async function getAdminApi(): Promise<APIRequestContext> {
  const ctx = await makeRequest.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Admin login failed: ${res.status()} ${await res.text()}`);
  }
  return ctx;
}

async function createPendingUser(
  ctx: APIRequestContext,
  email: string,
  password: string,
  name: string,
): Promise<void> {
  const res = await ctx.post("/api/auth/request-access", {
    data: { email, password, name },
  });
  if (res.status() !== 201) {
    throw new Error(`request-access failed: ${res.status()} ${await res.text()}`);
  }
}

async function findUserId(adminCtx: APIRequestContext, email: string): Promise<number> {
  const res = await adminCtx.get("/api/admin/users");
  if (!res.ok()) {
    throw new Error(`GET /api/admin/users failed: ${res.status()} ${await res.text()}`);
  }
  const users: Array<{ id: number; email: string }> = await res.json();
  if (!Array.isArray(users)) {
    throw new Error(`Expected array from /api/admin/users, got: ${JSON.stringify(users)}`);
  }
  const u = users.find((u) => u.email === email);
  if (!u) throw new Error(`User ${email} not found in admin list`);
  return u.id;
}

async function approveUser(adminCtx: APIRequestContext, id: number): Promise<void> {
  const res = await adminCtx.patch(`/api/admin/users/${id}`, {
    data: { status: "active" },
  });
  if (!res.ok()) {
    throw new Error(`approve failed: ${res.status()} ${await res.text()}`);
  }
}

async function deleteUser(adminCtx: APIRequestContext, id: number): Promise<void> {
  await adminCtx.delete(`/api/admin/users/${id}`);
}

// ---------------------------------------------------------------------------
// Test 1: Full request → approve → login flow
// ---------------------------------------------------------------------------
test("approved user can log in after admin approves their access request", async ({ page }) => {
  const email = `e2e-approve-${uid()}@example.com`;
  const password = "testPass123!";
  const adminCtx = await getAdminApi();

  await createPendingUser(adminCtx, email, password, "E2E Approve User");
  const userId = await findUserId(adminCtx, email);

  try {
    // Admin approves via API
    await approveUser(adminCtx, userId);

    // Approved user logs in via browser
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should reach the dashboard (not still on /login)
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveURL(/\//);
  } finally {
    await deleteUser(adminCtx, userId).catch(() => {});
    await adminCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Pending user is blocked from logging in
// ---------------------------------------------------------------------------
test("pending user sees 'awaiting approval' error and cannot log in", async ({ page }) => {
  const email = `e2e-pending-${uid()}@example.com`;
  const password = "testPass123!";
  const adminCtx = await getAdminApi();

  await createPendingUser(adminCtx, email, password, "E2E Pending User");
  const userId = await findUserId(adminCtx, email);

  try {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Must stay on /login — not redirected to dashboard
    await expect(page).toHaveURL(/login/);

    // Must show the "awaiting approval" error message
    await expect(page.getByText(/awaiting approval/i)).toBeVisible();
  } finally {
    await deleteUser(adminCtx, userId).catch(() => {});
    await adminCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// Test 3: Last-admin safeguard
// ---------------------------------------------------------------------------
test("sole admin cannot delete themselves or demote their own role", async ({ page }) => {
  const adminCtx = await getAdminApi();

  try {
    // Confirm this admin is the only active admin
    const usersRes = await adminCtx.get("/api/admin/users");
    const users: Array<{ id: number; email: string; role: string; status: string }> =
      await usersRes.json();
    const adminUser = users.find((u) => u.email === ADMIN_EMAIL);
    if (!adminUser) throw new Error("Admin user not found");
    const adminId = adminUser.id;

    // Remove any other test-admin accounts so we are the last admin
    const otherAdmins = users.filter(
      (u) => u.role === "admin" && u.status === "active" && u.id !== adminId,
    );
    for (const a of otherAdmins) {
      await adminCtx.patch(`/api/admin/users/${a.id}`, { data: { role: "user" } });
    }

    // 3a: Attempting to demote the last admin returns 409
    const demoteRes = await adminCtx.patch(`/api/admin/users/${adminId}`, {
      data: { role: "user" },
    });
    expect(demoteRes.status()).toBe(409);
    const demoteBody = await demoteRes.json();
    expect(demoteBody.error).toMatch(/last active admin/i);

    // 3b: Attempting to delete self returns 409
    const deleteRes = await adminCtx.delete(`/api/admin/users/${adminId}`);
    expect(deleteRes.status()).toBe(409);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.error).toMatch(/your own account/i);

    // 3c: UI shows the role as "(you)" text, not a dropdown
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/login/);

    await page.goto("/settings/users");
    // The admin's own role cell shows text "(you)" and no dropdown
    await expect(page.getByText(/\(you\)/i)).toBeVisible();
    // Delete button should not appear for own row
    const adminRow = page.getByRole("row").filter({ hasText: ADMIN_EMAIL });
    await expect(adminRow.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);
  } finally {
    await adminCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// Test 4: Role change is reflected immediately without re-login
// ---------------------------------------------------------------------------
test("role change to admin is reflected in nav without re-login", async ({ browser }) => {
  const email = `e2e-role-${uid()}@example.com`;
  const password = "testPass123!";
  const adminCtx = await getAdminApi();

  await createPendingUser(adminCtx, email, password, "E2E Role Change");
  const userId = await findUserId(adminCtx, email);
  await approveUser(adminCtx, userId);

  const userCtx = await browser.newContext();
  const userPage = await userCtx.newPage();

  try {
    // User logs in as 'user' role
    await userPage.goto("/login");
    await userPage.getByLabel(/email/i).fill(email);
    await userPage.getByLabel(/password/i).fill(password);
    await userPage.getByRole("button", { name: /sign in/i }).click();
    await expect(userPage).not.toHaveURL(/login/);

    // Confirm /settings/users is not accessible (redirected away)
    await userPage.goto("/settings/users");
    await expect(userPage).not.toHaveURL(/settings\/users/);

    // Admin promotes the user to admin via API
    const promoteRes = await adminCtx.patch(`/api/admin/users/${userId}`, {
      data: { role: "admin" },
    });
    expect(promoteRes.ok()).toBeTruthy();

    // User navigates to /settings/users without re-logging in.
    // /api/auth/me reads from DB on every call, so a fresh navigation triggers a re-check.
    await userPage.goto("/");
    await userPage.goto("/settings/users");

    // Should now be accessible — the User Management page heading is present
    await expect(userPage.getByRole("heading", { name: /user management/i })).toBeVisible();
  } finally {
    await userCtx.close();
    await deleteUser(adminCtx, userId).catch(() => {});
    await adminCtx.dispose();
  }
});
