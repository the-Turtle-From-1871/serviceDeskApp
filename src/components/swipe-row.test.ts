import { describe, it, expect } from "vitest";
import {
  axisFor,
  clampOffset,
  shouldOpen,
  releaseVelocity,
  withinLongPressSlop,
  DRAWER_WIDTH,
  AXIS_LOCK_PX,
  LONG_PRESS_SLOP_PX,
  STALE_VELOCITY_MS,
} from "./swipe-row";

describe("axisFor", () => {
  it("stays undecided until the finger has actually moved", () => {
    expect(axisFor(0, 0)).toBe("undecided");
    expect(axisFor(AXIS_LOCK_PX - 1, AXIS_LOCK_PX - 1)).toBe("undecided");
  });

  it("claims a clearly sideways gesture", () => {
    expect(axisFor(-40, 3)).toBe("horizontal");
    expect(axisFor(40, -3)).toBe("horizontal");
  });

  it("leaves a scroll alone", () => {
    expect(axisFor(4, -40)).toBe("vertical");
  });

  // The tie must not go to the swipe: a diagonal drag is far more often a
  // scroll that wandered than a deliberate sideways gesture, and stealing it
  // makes the list feel like it refuses to scroll.
  it("gives a 45-degree drag to the scroll, not the swipe", () => {
    expect(axisFor(-30, -30)).toBe("vertical");
  });
});

describe("clampOffset", () => {
  it("tracks a leftward drag one-for-one", () => {
    expect(clampOffset(-50, false)).toBe(-50);
  });

  it("refuses to travel further than the drawer is wide", () => {
    expect(clampOffset(-9999, false)).toBe(-DRAWER_WIDTH);
  });

  it("pins a rightward drag at rest — there is nothing behind the right edge", () => {
    expect(clampOffset(300, false)).toBe(0);
  });

  it("closes an already-open card when dragged back right", () => {
    expect(clampOffset(80, true)).toBe(-DRAWER_WIDTH + 80);
    expect(clampOffset(DRAWER_WIDTH + 50, true)).toBe(0);
  });

  it("cannot drag an open card past the drawer", () => {
    expect(clampOffset(-50, true)).toBe(-DRAWER_WIDTH);
  });
});

describe("shouldOpen", () => {
  it("opens past the halfway point", () => {
    expect(shouldOpen(-DRAWER_WIDTH * 0.6, 0)).toBe(true);
    expect(shouldOpen(-DRAWER_WIDTH * 0.4, 0)).toBe(false);
  });

  it("opens on a fast leftward flick that barely moved", () => {
    expect(shouldOpen(-20, -1.2)).toBe(true);
  });

  it("closes on a fast rightward flick from a nearly-open card", () => {
    expect(shouldOpen(-DRAWER_WIDTH * 0.9, 1.2)).toBe(false);
  });
});

describe("withinLongPressSlop", () => {
  it("tolerates the small drift of a finger trying to hold still", () => {
    expect(withinLongPressSlop(0, 0)).toBe(true);
    expect(withinLongPressSlop(LONG_PRESS_SLOP_PX, -LONG_PRESS_SLOP_PX)).toBe(true);
  });

  // Deliberately tighter than AXIS_LOCK_PX, so a finger that is turning into
  // either a swipe or a scroll is disqualified before the timer can fire.
  it("rejects a finger that has started travelling", () => {
    expect(withinLongPressSlop(LONG_PRESS_SLOP_PX + 1, 0)).toBe(false);
    expect(withinLongPressSlop(0, LONG_PRESS_SLOP_PX + 1)).toBe(false);
    expect(LONG_PRESS_SLOP_PX).toBeLessThan(AXIS_LOCK_PX);
  });
});

describe("releaseVelocity", () => {
  it("keeps a velocity sampled just before the lift", () => {
    expect(releaseVelocity(-1.2, 0)).toBe(-1.2);
    expect(releaseVelocity(-1.2, STALE_VELOCITY_MS)).toBe(-1.2);
  });

  it("discards a velocity the finger has already stopped earning", () => {
    // Flick left fast, pause to reconsider, lift: without this the drawer
    // opens on a gesture the user visibly abandoned.
    expect(releaseVelocity(-1.2, STALE_VELOCITY_MS + 1)).toBe(0);
    expect(releaseVelocity(-1.2, 1000)).toBe(0);
  });

  it("leaves a stale release to be decided by distance alone", () => {
    // Zeroed velocity falls through to the distance rule in shouldOpen.
    expect(shouldOpen(-DRAWER_WIDTH * 0.9, releaseVelocity(-1.2, 500))).toBe(true);
    expect(shouldOpen(-DRAWER_WIDTH * 0.1, releaseVelocity(-1.2, 500))).toBe(false);
  });
});
