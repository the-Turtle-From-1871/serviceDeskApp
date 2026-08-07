"use client";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  axisFor,
  clampOffset,
  shouldOpen,
  DRAWER_WIDTH,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
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
};

export type RowGestures = {
  /** The row whose action drawer is currently open, if any. */
  openId: string | null;
  /** Where the row should sit, in px (negative = leftward): the live drag if
   *  this row is under a finger, otherwise its resting place. One function so
   *  no caller has to remember that a row dragged back to exactly 0 is still
   *  the open row and must NOT snap to the drawer. */
  offsetFor: (rowId: string) => number;
  /** The row under an active drag, if any. That row must not animate, or it
   *  lags behind the finger. */
  draggingId: string | null;
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
  const [drag, setDrag] = useState<{ rowId: string; offset: number } | null>(null);
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
    setDrag(null);
  }, []);

  const closeDrawer = useCallback(() => setOpenId(null), []);

  const consumeSuppressedClick = useCallback((rowId: string) => {
    if (suppressClick.current !== rowId) return false;
    suppressClick.current = null;
    return true;
  }, []);

  const onPointerDown = useCallback(
    (rowId: string) => (e: ReactPointerEvent<HTMLElement>) => {
      // Right-click and the middle button are not gestures, and a press that
      // starts on a button inside the drawer must reach that button untouched.
      if (e.button !== 0) return;
      // Touch and pen only. A mouse has no business here: the card layout and
      // its drawer exist only under the 720px breakpoint, so a mouse-drag on a
      // desktop table would translate a row with nothing behind it, and a
      // held-down mouse button would silently enter selection mode. This is
      // also why neither gesture needs a viewport check.
      if (e.pointerType === "mouse") return;

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

      if (Math.abs(dx) > LONG_PRESS_SLOP_PX || Math.abs(dy) > LONG_PRESS_SLOP_PX) clearTimer();
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
            endGesture();
            return;
          }
          // Claim the pointer only now: capturing on pointerdown would swallow
          // taps meant for the buttons inside the drawer.
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
      }

      if (g.axis !== "horizontal") return;

      const now = Date.now();
      const dt = now - g.lastT;
      if (dt > 0) g.velocity = (e.clientX - g.lastX) / dt;
      g.lastX = e.clientX;
      g.lastT = now;

      setDrag({ rowId, offset: clampOffset(dx, g.startedOpen) });
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
        setOpenId(shouldOpen(offset, g.velocity) ? rowId : null);
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
      // Settle back to whatever the drawer was before the gesture started.
      endGesture();
    },
    [endGesture],
  );

  const offsetFor = useCallback(
    (rowId: string) => {
      if (drag && drag.rowId === rowId) return drag.offset;
      return openId === rowId ? -DRAWER_WIDTH : 0;
    },
    [drag, openId],
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
    draggingId: drag?.rowId ?? null,
    closeDrawer,
    consumeSuppressedClick,
    pointerHandlers,
  };
}
