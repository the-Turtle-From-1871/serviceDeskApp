import { expect, test } from "@playwright/test";

test("unauthenticated visitor can view the public home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  // The heading was renamed when the home search stopped being receipt-only
  // (2c373b5); this assertion was left behind and has been failing ever since.
  // E2E does not run in CI, which is why nobody noticed.
  await expect(page.getByRole("heading", { name: "Find an item or hand receipt" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
});

test("unauthenticated user is redirected to login from an authed route", async ({ page }) => {
  await page.goto("/new");
  await expect(page).toHaveURL(/\/login/);
});

const SESSION_COOKIE = "authjs.session-token";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "admin@example.com");
  await page.fill('input[name="password"]', "ChangeMe123!");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test("admin can sign in", async ({ page }) => {
  await signIn(page);
});

test("the session cookie is re-issued on every request", async ({ page, context }) => {
  // This is the mechanism the 4-hour idle timeout rides on, and nothing else
  // can see it. The unit tests drive the `jwt` callback directly, so they prove
  // the POLICY but not that the refreshed token ever reaches the browser — and
  // only the proxy copies the session action's Set-Cookie onto the response
  // (`handleAuth` in next-auth/lib/index.js). The bare `auth()` used by RSC
  // re-signs a token and discards it.
  //
  // So if the proxy matcher ever stopped covering an authenticated route, the
  // idle clock would silently degrade to "4 hours from sign-in" with the whole
  // unit suite still green. This test fails instead.
  await signIn(page);
  const cookieValue = async () =>
    (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value;

  const atSignIn = await cookieValue();
  expect(atSignIn, "signing in should set a session cookie").toBeTruthy();

  // The token is re-stamped with second precision, so a same-second navigation
  // can legitimately produce an identical string.
  await page.waitForTimeout(1100);
  await page.goto("/items");
  await page.waitForLoadState("domcontentloaded");

  expect(await cookieValue()).not.toBe(atSignIn);
});
