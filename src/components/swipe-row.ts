/**
 * Pure gesture arithmetic for the mobile swipe card on /items.
 *
 * Why it is a leaf file with no React and no DOM: the interesting part of a
 * swipe is the decision-making (is this gesture horizontal or is the user
 * scrolling the page? how far may the card travel? does releasing here open or
 * snap back?), and every one of those decisions is a bug you only notice on a
 * real phone. Kept as plain functions they are unit-testable directly, which is
 * the same split `readiness.ts` and `recipient-search.ts` use — the hook in
 * useRowGestures.ts owns pointer events and React state and nothing else.
 */

/** The breakpoint at which /items rows stop being table rows and become cards.
 *
 *  MUST match the `@media (max-width: 720px)` block in globals.css — the same
 *  720px the header nav and the bottom rail switch at. It is read at EVENT time
 *  only (a click handler deciding whether a tap means "open" or "select"),
 *  never during render: a render-time viewport check is what CLAUDE.md forbids,
 *  because a Server Component cannot do one and a client one flashes the wrong
 *  layout on first paint. */
export const CARD_LAYOUT_QUERY = "(max-width: 720px)";

/** Whether the card layout is the one on screen right now. Event-time only. */
export function isCardLayout(): boolean {
  return typeof window !== "undefined" && window.matchMedia(CARD_LAYOUT_QUERY).matches;
}

/** Width of the action drawer revealed behind a card, in px.
 *
 *  Three actions (Edit / Retire / Delete) at 60px each — comfortably over the
 *  44px `--tap` floor in both dimensions, since each is a full-height column.
 *  Sized against the card, not against the labels: at a 390px viewport the
 *  card is 356px wide, so a wider drawer slides more than half the card off
 *  the screen and what is left reads as a blank panel. Measured at 216 first;
 *  the device name and both badges had gone.
 *
 *  Mirrored by `--swipe-drawer-w` in globals.css — the gesture clamps the
 *  card's travel to this number, so if the two drift the card either stops
 *  short of the last button or slides onto bare background. */
export const DRAWER_WIDTH = 180;

/** Horizontal travel, in px, before a gesture is claimed as a swipe.
 *
 *  Below this the pointer stream is still ambiguous and must be left alone: a
 *  finger starting a vertical scroll wanders a few px sideways, and stealing it
 *  as a swipe makes the list feel like it refuses to scroll. */
export const AXIS_LOCK_PX = 10;

/** Fraction of the drawer the card must have travelled, at release, to settle
 *  open rather than snap shut. Half is the least surprising rule: the card ends
 *  wherever it looked like it was going. */
const OPEN_FRACTION = 0.5;

/** Release speed (px/ms) that opens the drawer regardless of distance — a
 *  short, fast flick is a deliberate gesture and should not be punished for
 *  covering less than half the width. */
const FLICK_VELOCITY = 0.5;

export type GestureAxis = "undecided" | "horizontal" | "vertical";

/**
 * Classify a gesture from its total displacement so far.
 *
 * Vertical is locked in as soon as the finger has moved at all vertically and
 * is not clearly going sideways, because the cost of the two errors is not
 * symmetric: mistaking a scroll for a swipe breaks the page, while mistaking a
 * swipe for a scroll just means the card does not open and the user tries
 * again.
 */
export function axisFor(dx: number, dy: number): GestureAxis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < AXIS_LOCK_PX && ay < AXIS_LOCK_PX) return "undecided";
  return ax > ay ? "horizontal" : "vertical";
}

/**
 * The card's offset, in px, for a raw horizontal displacement.
 *
 * Negative is leftward (the direction that reveals the drawer). Rightward drag
 * is pinned at 0 — there is nothing behind the card's right edge — and leftward
 * drag stops at the drawer's own width. `startedOpen` carries the offset the
 * gesture began from, so dragging an already-open card closes it.
 */
export function clampOffset(dx: number, startedOpen: boolean): number {
  const raw = (startedOpen ? -DRAWER_WIDTH : 0) + dx;
  if (raw > 0) return 0;
  if (raw < -DRAWER_WIDTH) return -DRAWER_WIDTH;
  return raw;
}

/**
 * Where a released card settles.
 *
 * `velocity` is px/ms, signed like the offset (negative = still moving left).
 * A flick decides on its own; anything slower is decided by distance travelled.
 */
export function shouldOpen(offset: number, velocity: number): boolean {
  if (velocity <= -FLICK_VELOCITY) return true;
  if (velocity >= FLICK_VELOCITY) return false;
  return offset <= -DRAWER_WIDTH * OPEN_FRACTION;
}

/** Long-press duration, in ms, that enters selection mode.
 *
 *  500ms is the platform convention for "press and hold" on both iOS and
 *  Android. Shorter starts firing on ordinary taps that linger; longer feels
 *  broken. */
export const LONG_PRESS_MS = 500;

/** How far a finger may drift during a press and still count as a long press.
 *  Deliberately under AXIS_LOCK_PX, so a press that is turning into either a
 *  swipe or a scroll has already been disqualified by the time it fires. */
export const LONG_PRESS_SLOP_PX = 8;

/** Whether a finger that has moved (dx, dy) is still holding still enough to
 *  count as a press.
 *
 *  Only the slop half of "long press" lives here — the duration half belongs to
 *  the timer in useRowGestures, which already measures elapsed time better than
 *  a function can. The hook calls THIS rather than re-deriving the rule inline,
 *  so the tested code and the shipped code cannot drift apart. */
export function withinLongPressSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) <= LONG_PRESS_SLOP_PX && Math.abs(dy) <= LONG_PRESS_SLOP_PX;
}

/** How long after the last movement sample a release still counts as "moving".
 *
 *  Velocity is only sampled on pointermove, so a finger that flicks and then
 *  rests before lifting sends no further samples and the last one survives to
 *  the release. Without this the card opens on a gesture the user visibly
 *  abandoned — flick, pause, think better of it, lift. One frame at 60Hz is
 *  ~17ms, so 100ms is several frames of genuine stillness, not jitter. */
export const STALE_VELOCITY_MS = 100;

/** The velocity a release should actually be judged on.
 *
 *  `msSinceLastSample` is the gap between the last pointermove and the lift.
 *  A stale sample is discarded rather than decayed: the question at release is
 *  only "was the finger still moving", and a paused finger was not. */
export function releaseVelocity(velocity: number, msSinceLastSample: number): number {
  return msSinceLastSample > STALE_VELOCITY_MS ? 0 : velocity;
}
