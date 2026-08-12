/**
 * Is this page running as an INSTALLED app rather than in a browser tab?
 *
 * CLIENT-ONLY. It reads `window`, so call it from an event handler — never at
 * render and never on the server. It returns false rather than throwing when
 * there is no `window`, so an accidental server call fails safe (to the
 * browser behaviour) instead of crashing a page.
 *
 * BOTH halves are required, and neither is redundant:
 *   • `display-mode: standalone` is the standard, and is what Android and
 *     desktop installs answer to.
 *   • `navigator.standalone` is a legacy, iOS-only property. Older iPhones
 *     answer ONLY that one — and the iPhone home-screen install is the case
 *     this function exists for, so it is not an optional extra.
 *
 * `matchMedia` is called optionally because jsdom does not implement it, so an
 * unstubbed component test would otherwise throw here rather than exercising
 * the browser path it means to.
 *
 * This is NOT one of the three proxy-safe files in this directory
 * (`rate-limit.ts`, `public-access-cookie.ts`, `session-freshness.ts`) and has
 * nothing to do with that rule — `src/proxy.ts` does not import it.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}
