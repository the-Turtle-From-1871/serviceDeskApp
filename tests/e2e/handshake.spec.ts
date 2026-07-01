import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test("holder initiates, recipient signs, custody moves", async ({ page }) => {
  // Alice initiates from her dashboard's held item.
  await login(page, "a@example.com");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: /Dell 5540/ }).click();
  await page.getByRole("combobox").selectOption({ label: "Bob" });
  await page.getByRole("button", { name: /Initiate transfer/ }).click();
  await expect(page.getByText(/recipient must sign/i)).toBeVisible();

  // Bob signs and accepts.
  await login(page, "b@example.com");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: /Sign for/ }).click();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 60);
  await page.mouse.move(box!.x + 200, box!.y + 100);
  await page.mouse.up();

  // Verify the signature actually captured before submitting.
  await expect(page.locator('input[name="signature"]')).not.toHaveValue("");

  await page.getByRole("button", { name: /Accept custody/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("link", { name: /Dell 5540/ })).toBeVisible(); // Bob now holds it
});
