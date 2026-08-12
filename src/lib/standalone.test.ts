// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { isStandaloneDisplay } from "./standalone";

/**
 * jsdom implements NO `window.matchMedia` — it is undefined unless stubbed —
 * which is exactly why the implementation calls it optionally. A test that
 * forgets to stub it is therefore testing the real "browser tab" answer.
 */
const stubMatchMedia = (matches: boolean) =>
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })));

const stubLegacyIos = (value: boolean | undefined) =>
  Object.defineProperty(window.navigator, "standalone", { value, configurable: true });

afterEach(() => {
  vi.unstubAllGlobals();
  stubLegacyIos(undefined);
});

test("a plain browser tab is not standalone", () => {
  stubMatchMedia(false);
  expect(isStandaloneDisplay()).toBe(false);
});

test("no matchMedia at all is not standalone, rather than a throw", () => {
  // jsdom's own default. Also the shape of an ancient browser.
  expect(isStandaloneDisplay()).toBe(false);
});

test("the display-mode media query is enough", () => {
  stubMatchMedia(true);
  expect(isStandaloneDisplay()).toBe(true);
});

/**
 * The case this whole feature exists for. Older iPhones answer ONLY the legacy
 * property, so dropping this half would leave the home-screen install — the
 * one place with no back button — taking the browser path.
 */
test("legacy navigator.standalone alone is enough", () => {
  stubMatchMedia(false);
  stubLegacyIos(true);
  expect(isStandaloneDisplay()).toBe(true);
});
