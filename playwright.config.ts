import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
    // Cloudflare's documented always-pass TEST keys, so these specs can sign in.
    //
    // Turnstile is doing its job when it refuses Playwright: it declines to
    // issue a token to an automated browser (verified — the widget renders,
    // fires no error, and simply never calls back), which leaves the sign-in
    // button held at "Checking your browser…" forever. With real keys in
    // `.env.local` the auth specs cannot pass, and the failure looks like a
    // broken login rather than a working CAPTCHA.
    //
    // These override `.env.local` because `@next/env` never overwrites a
    // variable already present in the process environment. Note this only
    // applies to a server Playwright starts — `reuseExistingServer` means a dev
    // server you left running keeps whatever keys it booted with.
    env: {
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    },
  },
});
