import { expect, test } from "@playwright/test";

test("unauthenticated user is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("admin can sign in", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "admin@example.com");
  await page.fill('input[name="password"]', "ChangeMe123!");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
});
