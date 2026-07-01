import { expect, test } from "@playwright/test";

// Assumes at least one item exists; create via admin UI or a seed before running.
test("unauthenticated visitor can view item details but sees sign-in prompt", async ({ page, request }) => {
  // Create an item through admin session is out of scope here; this test navigates to a known seeded item id via env.
  const itemId = process.env.E2E_ITEM_ID;
  test.skip(!itemId, "Set E2E_ITEM_ID to a real item to run this test");
  await page.goto(`/i/${itemId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Sign in")).toBeVisible();
});
