import { expect, test } from "@playwright/test";

test("unauthenticated visitor can view the public home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Find your hand receipt" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
});

test("unauthenticated user is redirected to login from an authed route", async ({ page }) => {
  await page.goto("/new");
  await expect(page).toHaveURL(/\/login/);
});

test("admin can sign in", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "admin@example.com");
  await page.fill('input[name="password"]', "ChangeMe123!");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
});
