"use client";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  axisFor,
  clampOffset,
  isCardLayout,
  releaseVelocity,
  shouldOpen,
  DRAWER_WIDTH,
  LONG_PRESS_MS,
  withinLongPressSlop,
  type GestureAxis,
} from "./swipe-row";

/**
 * Pointer wiring for the mobile item cards: swipe-left to reveal a row's
 * actions, press-and-hold to enter selection mode.
 *
 * All the arithmetic lives in the pure `swipe-row.ts` beside this file; what is
 * here is the stateful part that cannot be unit-tested without a real touch
 * screen — pointer capture, timers, and the one piece of bookkeeping that makes
 * the whole thing usable: suppressing the click that a gesture leaves behind.
 *
 * That suppression is the crux. The card is a stretched link (tapping it opens
 * the item), so EVERY gesture that ends on the card also fires a click on that
 * link — finishing a swipe would navigate away from the actions you just
 * revealed, and a long-press would navigate instead of selecting. A capture
 * phase handler asks `consumeSuppressedClick()` first and cancels the
 * navigation when a gesture, not a tap, produced it.
 */

type Gesture = {
  rowId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Offset the card already had when this gesture began, so dragging an open
   *  card back to the right closes it instead of jumping to 0 first. */
  startedOpen: boolean;
  axis: GestureAxis;
  /** Last sample, for the release velocity. */
  lastX: number;
  lastT: number;
  velocity: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  fired: boolean;
  /** The row's own element, once the gesture is committed to a swipe. The drag
   *  is written straight to it instead of through React state — see
   *  onPointerMove. */
  el: HTMLElement | null;
};

export type RowGestures = {
  /** The row whose action drawer is currently open, if any. */
  openId: string | null;
  /** Where the row RESTS, in px (negative = leftward). The live drag is not
   *  here: it is written straight to the dragged node, so a swipe costs no
   *  renders at all. Both paths settle on the same value. */
  offsetFor: (rowId: string) => number;
  closeDrawer: () => void;
  /** Whether this row's next card click was produced by a gesture rather than
   *  a tap, and so must not navigate. Reads AND clears. Call once, from a
   *  capture-phase click handler. */
  consumeSuppressedClick: (rowId: string) => boolean;
  pointerHandlers: (rowId: string) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
};

export function useRowGestures({
  swipeEnabled,
  longPressEnabled,
  onLongPress,
}: {
  /** Admin-only, and off during selection mode — see ItemSelectTable. */
  swipeEnabled: boolean;
  longPressEnabled: boolean;
  onLongPress: (rowId: string) => void;
}): RowGestures {
  const [openId, setOpenId] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The row whose next card click a gesture has already spent, or null.
   *
   *  Scoped to a row rather than a bare boolean because the click a gesture
   *  suppresses may never arrive — a fling that lifts off over the drawer
   *  produces none — and a global flag left behind that way swallows the next
   *  tap on a completely different card. Keyed by row, a stale flag can only
   *  ever cost the row that set it one click, and the pointerdown reset below
   *  clears even that. */
  const suppressClick = useRef<string | null>(null);

  const clearTimer = () => {
    const g = gesture.current;
    if (g?.longPressTimer) {
      clearTimeout(g.longPressTimer);
      g.longPressTimer = null;
    }
  };

  const endGesture = useCallback(() => {
    clearTimer();
    gesture.current = null;
  }, []);

  const closeDrawer = useCallback(() => setOpenId(null), []);

  const consumeSuppressedClick = useCallback((rowId: string) => {
    if (suppressClick.current !== rowId) return false;
    suppressClick.current = null;
    return true;
  }, []);

  const onPointerDown = useCallback(
    (rowId: string) => (e: ReactPointerEvent<HTMLElement>) => {
      // Right-click and the middle button are not gestures.
      if (e.button !== 0) return;
      // Touch and pen only. A mouse has no business here: a mouse-drag on the
      // desktop table would translate a row with nothing behind it, and a
      // held-down mouse button would silently enter selection mode.
      if (e.pointerType === "mouse") return;
      // A touch device WIDER than the breakpoint (iPad landscape at 1024px, an
      // iPad Mini at 744px, a Surface) still sends pointerType "touch" — but
      // every transform that makes a gesture visible lives inside the 720px
      // media block. Without this the row goes invisibly "open": nothing moves,
      // and the next tap is spent closing a drawer the user never saw. Checked
      // at event time, which is the only time it is safe to look at the
      // viewport (see CARD_LAYOUT_QUERY).
      if (!isCardLayout()) return;
      // A press that starts on a control belongs to that control. `e.button`
      // above is the MOUSE button, not an HTML <button>, so it never covered
      // this: holding Edit for 500ms used to fire the long press, toggle the
      // row into the selection, and retract the drawer out from under the
      // finger — while the click still went through to Edit.
      //
      // `a` is deliberately NOT in this list, and must never be added. The
      // card's tap target is a STRETCHED link whose ::after covers the entire
      // row, so every touch anywhere on a card reports an <a> as its target —
      // matching on it refuses every gesture the feature exists for, and the
      // swipe silently stops working on both tables. (It shipped that way for
      // one round and only a real-browser swipe caught it; jsdom has no
      // hit-testing, so the target there is whatever element the test names.)
      // The drawer's own links are inside `td.row-actions`, which is matched.
      if ((e.target as HTMLElement | null)?.closest?.("td.row-actions, button, input, label")) {
        return;
      }
      // One gesture at a time. `gesture.current` is a single slot, so a second
      // finger landing on another row used to overwrite it — leaving the first
      // row translated mid-swipe with `transition: none` until that second
      // gesture happened to end. Two-finger scrolls and pinch-zooms do this
      // routinely. The first finger keeps the gesture; later ones are inert.
      if (gesture.current) return;

      // A gesture that ended somewhere other than on the card (a fling that
      // lifted over the drawer) leaves the flag set with no click to spend it
      // on. Clearing it here rather than on a timer means a stale flag can
      // never outlive the gesture that set it.
      suppressClick.current = null;

      // Tapping any part of a DIFFERENT card while one is open dismisses it.
      // The tap is spent on the dismissal rather than also navigating — the
      // same way a tap outside an open menu closes it and nothing else.
      if (openId && openId !== rowId) {
        setOpenId(null);
        suppressClick.current = rowId;
      }

      const now = Date.now();
      const g: Gesture = {
        rowId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startedOpen: openId === rowId,
        axis: "undecided",
        lastX: e.clientX,
        lastT: now,
        velocity: 0,
        longPressTimer: null,
        fired: false,
        el: null,
      };
      gesture.current = g;

      if (longPressEnabled) {
        g.longPressTimer = setTimeout(() => {
          // The slop check lives in the move handler (which cancels the timer),
          // so reaching this callback already means the finger stayed put.
          if (gesture.current !== g) return;
          g.fired = true;
          g.longPressTimer = null;
          suppressClick.current = rowId;
          // Confirms the mode switch on a device where the visual change is
          // under the user's own finger. Absent on iOS Safari; guarded.
          navigator.vibrate?.(10);
          onLongPress(rowId);
        }, LONG_PRESS_MS);
      }
    },
    [openId, longPressEnabled, onLongPress],
  );

  const onPointerMove = useCallback(
    (rowId: string) => (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.rowId !== rowId || g.pointerId !== e.pointerId) return;

      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;

      if (!withinLongPressSlop(dx, dy)) clearTimer();
      if (g.fired) return;

      if (g.axis === "undecided") {
        g.axis = axisFor(dx, dy);
        // A vertical gesture is the page scrolling. Let go of it completely:
        // `touch-action: pan-y` means the browser is already handling it, and
        // anything we do from here only fights the scroll.
        if (g.axis === "vertical") {
          endGesture();
          return;
        }
        if (g.axis === "horizontal") {
          if (!swipeEnabled) {
            // Spend the click even though nothing will move. `touch-action`
            // hands horizontal gestures to us, so the browser still synthesises
            // a click at touchend — and it lands on the stretched card link.
            // Without this a standard user (whose drawer is empty, and who has
            // no grip to suggest otherwise) drags a card sideways and is taken
            // to the item page instead of nothing happening.
            suppressClick.current = rowId;
            endGesture();
            return;
          }
          // Claim the pointer only now: capturing on pointerdown would swallow
          // taps meant for the buttons inside the drawer.
          e.currentTarget.setPointerCapture?.(e.pointerId);
          // The row's own element, so the drag can be written straight to it —
          // see below. A row under a finger must track it exactly, so the CSS
          // snap transition is suppressed for the duration of the drag.
          g.el = e.currentTarget;
          g.el.style.transition = "none";
        }
      }

      if (g.axis !== "horizontal") return;

      const now = Date.now();
      const dt = now - g.lastT;
      if (dt > 0) g.velocity = (e.clientX - g.lastX) / dt;
      g.lastX = e.clientX;
      g.lastT = now;

      // Written DIRECTLY to the dragged row's style, deliberately bypassing
      // React. This used to be `setDrag(...)`, i.e. component state, which
      // re-rendered the whole page — 50 rows, each carrying the card cells and
      // a full drawer including DeleteItemButton — on every pointermove, at up
      // to 120Hz, on exactly the phones this feature is for. Only one custom
      // property on one node actually changes, and pointerup below settles the
      // DOM to the same value React will render from `openId`, so the two never
      // disagree.
      g.el?.style.setProperty("--swipe", `${clampOffset(dx, g.startedOpen)}px`);
    },
    [swipeEnabled, endGesture],
  );

  const onPointerUp = useCallback(
    (rowId: string) => (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.rowId !== rowId || g.pointerId !== e.pointerId) return;
      clearTimer();

      if (g.fired) {
        // The long press already did its work on the timer; the release is
        // only here to tear down.
        endGesture();
        return;
      }

      if (g.axis === "horizontal") {
        const offset = clampOffset(e.clientX - g.startX, g.startedOpen);
        // Judge the release on a FRESH sample only — see releaseVelocity.
        const v = releaseVelocity(g.velocity, Date.now() - g.lastT);
        const open = shouldOpen(offset, v);
        // Settle the node to EXACTLY what React is about to render from
        // `openId`. Writing the resting value (rather than clearing the
        // property) is what keeps the direct-DOM drag above consistent with
        // React's model: when a row is re-opened from an already-open state
        // the rendered value does not change, so React skips the style and the
        // DOM must already be right. The transition override is dropped here
        // so the snap animates.
        g.el?.style.setProperty("--swipe", open ? `${-DRAWER_WIDTH}px` : "0px");
        g.el?.style.removeProperty("transition");
        setOpenId(open ? rowId : null);
        suppressClick.current = rowId;
      } else if (g.startedOpen) {
        // A plain tap on an open card closes it rather than navigating —
        // otherwise the drawer is impossible to dismiss without acting on it.
        setOpenId(null);
        suppressClick.current = rowId;
      }

      endGesture();
    },
    [endGesture],
  );

  const onPointerCancel = useCallback(
    (rowId: string) => (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.rowId !== rowId || g.pointerId !== e.pointerId) return;
      // The system took the pointer away (a scroll took over, a call came in).
      // Settle back to whatever the drawer was before the gesture started —
      // the drag wrote straight to the DOM, so React will not do it for us.
      g.el?.style.setProperty("--swipe", g.startedOpen ? `${-DRAWER_WIDTH}px` : "0px");
      g.el?.style.removeProperty("transition");
      endGesture();
    },
    [endGesture],
  );

  const offsetFor = useCallback(
    (rowId: string) => (openId === rowId ? -DRAWER_WIDTH : 0),
    [openId],
  );

  const pointerHandlers = useCallback(
    (rowId: string) => ({
      onPointerDown: onPointerDown(rowId),
      onPointerMove: onPointerMove(rowId),
      onPointerUp: onPointerUp(rowId),
      onPointerCancel: onPointerCancel(rowId),
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel],
  );

  return {
    openId,
    offsetFor,
    closeDrawer,
    consumeSuppressedClick,
    pointerHandlers,
  };
}
