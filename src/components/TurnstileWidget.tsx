"use client";
import { useEffect, useRef } from "react";

// The Cloudflare Turnstile widget, rendered EXPLICITLY rather than by the
// script's own class scan.
//
// Implicit rendering (`<div class="cf-turnstile">` + a plain `<script>`) is what
// Cloudflare's docs show, but it races React: the script scans the DOM once on
// load, and under hydration the container may not exist yet — leaving a form
// that silently submits with no token, which the server then refuses. Explicit
// rendering removes the race by calling `render()` on a node we know is mounted.
//
// The widget injects a hidden `cf-turnstile-response` input into the enclosing
// `<form>`, so the token reaches the Server Action through FormData with no
// wiring here. Keep this component INSIDE the `<form>`.

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | undefined;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// One shared promise per document: both /login and /forgot-password mount this,
// and a second <script> tag would re-register the global and orphan live
// widgets. Module scope is per-tab, which is the right lifetime.
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    // A fresh tag every time, and the dead one is REMOVED on failure.
    // Re-attaching to an existing `<script>` would be a trap: a tag that has
    // already fired its terminal `error` never fires another event, so the
    // retry's promise would hang forever, `render()` would never run, and the
    // form would submit with no token — a sign-in that cannot succeed until the
    // page is fully reloaded, from one flaky CDN fetch.
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("turnstile script failed to load"));
    });
    document.head.appendChild(script);
  });
  // A failed load must not poison the cache — the next mount should be able to
  // try again (a flaky network, a tab that was offline when the form opened).
  scriptPromise.catch(() => {
    scriptPromise = null;
  });
  return scriptPromise;
}

/**
 * `pending` — no usable token yet (still solving, or the visitor must interact).
 * `ready` — a token is in the form and the submission will carry it.
 * `error` — the challenge could not run at all (blocked CDN, offline).
 */
export type TurnstileStatus = "pending" | "ready" | "error";

export function TurnstileWidget({
  siteKey,
  /**
   * Change this to force a fresh challenge. A token is single-use, so after a
   * rejected submission the spent one must be replaced or the next attempt is
   * refused for a reason the user cannot see. Pass the Server Action's state
   * object — `useActionState` hands back a new object per result, so identity
   * changes even when the message is the same.
   */
  resetOn,
  /**
   * Reports whether a token is available yet, so the form can hold the submit
   * button until it is.
   *
   * Without this the challenge is a race the user loses: typing an email and
   * password takes a second or two, and submitting before Cloudflare has
   * answered sends a tokenless form, which the server correctly refuses with
   * "could not verify that request came from a browser" — for a completely
   * valid login. Verified: it happens on a fast submit against real keys.
   */
  onStatus,
}: {
  siteKey: string;
  resetOn?: unknown;
  onStatus?: (status: TurnstileStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);
  // Held in a ref so the render effect does not re-run (and re-render the
  // widget) every time the parent passes a new inline callback. Assigned in an
  // effect rather than during render — a ref write during render is a lint
  // error and, under concurrent rendering, a real hazard.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  });

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    const report = (s: TurnstileStatus) => {
      if (!cancelled) onStatusRef.current?.(s);
    };

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          callback: () => report("ready"),
          // A token lives ~5 minutes. `refresh-expired: auto` fetches a new one,
          // so this is a brief gap, not a dead end — but the form must not
          // submit during it.
          "expired-callback": () => report("pending"),
          "error-callback": () => report("error"),
          // Invisible in the ordinary case: the widget shows itself only when
          // Cloudflare decides the visitor must interact.
          appearance: "interaction-only",
          // A token expires after ~5 minutes. Someone who opens the sign-in
          // page and walks away must not come back to a form that cannot be
          // submitted, so refresh rather than expire.
          "refresh-expired": "auto",
          // Failure here means no token, which the server treats as a refused
          // submission. Retrying is strictly better than failing silently.
          "retry": "auto",
        });
      })
      .catch((err) => {
        // Blocked script, offline, or a corporate proxy eating the CDN. Logged
        // rather than surfaced: the submission will be refused server-side with
        // a message the user can act on, and a broken widget must not replace
        // the form with an error screen.
        console.error("[turnstile] widget unavailable", err);
        report("error");
      });

    return () => {
      cancelled = true;
      const id = widgetIdRef.current;
      if (id && window.turnstile) {
        window.turnstile.remove(id);
        widgetIdRef.current = undefined;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    // Skipped on mount: `resetOn` starts undefined and there is nothing spent
    // yet. Resetting here would throw away the challenge just rendered.
    if (resetOn === undefined) return;
    const id = widgetIdRef.current;
    if (id && window.turnstile) {
      // Back to pending until the replacement token arrives, or the form would
      // let the next attempt through carrying the token that was just spent.
      onStatusRef.current?.("pending");
      window.turnstile.reset(id);
    }
  }, [resetOn]);

  // The widget renders into this node and injects the hidden
  // `cf-turnstile-response` field into the enclosing form itself.
  // `interaction-only` keeps it zero-height until Cloudflare needs the visitor
  // to do something.
  return <div ref={containerRef} />;
}
