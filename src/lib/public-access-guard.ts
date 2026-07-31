import "server-only";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  shouldAllowPublic,
  unlockCookieName,
  verifyUnlockValue,
} from "@/lib/public-access-cookie";

/**
 * "May this caller see public item/receipt DATA?" — the same question
 * `src/proxy.ts` asks for `/i/*` and `/receipts/*`, answered from inside a
 * Server Component or Server Action.
 *
 * WHY THIS EXISTS. `/` is deliberately NOT PIN-gated in the proxy: the home
 * page has to be readable by a logged-out stranger, because it is the page that
 * explains what this application is (Google's OAuth branding verification
 * requires a publicly reachable home page, and a redirect to `/unlock` fails
 * it). But the home page also carries the type-ahead search, and a Server
 * Action POSTs to the path of the page that hosts it — so the moment `/` stopped
 * being PIN-gated, `liveSearchAction` lost the only thing that was gating it.
 * The gate did not move to the page; it moved to the DATA. `page.tsx` uses this
 * to decide what to render, and `liveSearchAction` uses it to refuse — the
 * render check is a courtesy, the action check is the control.
 *
 * The decision itself stays in `shouldAllowPublic`, shared with the proxy, so
 * "flag off = open" and "logged in = bypass" cannot come to mean two different
 * things on the two paths. Only the expensive lookups are skipped when the
 * answer cannot depend on them.
 *
 * `getSession` (the token) rather than `getCurrentUser` (a DB row), matching the
 * proxy's `!!req.auth`. Nothing is lost: the `jwt` callback already returns null
 * for a deactivated user or a stale session, so a revoked token is not a session
 * here either — and this avoids a per-keystroke query on the search path.
 */
export async function publicAccessAllowed(): Promise<boolean> {
  const flagEnabled = process.env.PUBLIC_ACCESS_PIN_ENABLED === "true";
  const loggedIn = flagEnabled ? !!(await getSession())?.user : false;
  const secret = process.env.AUTH_SECRET ?? "";
  const secure = process.env.NODE_ENV === "production";
  const presented =
    flagEnabled && !loggedIn ? (await cookies()).get(unlockCookieName(secure))?.value : undefined;
  const unlockValid =
    flagEnabled && !loggedIn ? (await verifyUnlockValue(presented, secret, Date.now())).valid : false;
  return shouldAllowPublic({ flagEnabled, loggedIn, unlockValid });
}
