import { describe, it, expect } from "vitest";
import {
  axisFor,
  clampOffset,
  shouldOpen,
  isLongPress,
  DRAWER_WIDTH,
  AXIS_LOCK_PX,
  LONG_PRESS_MS,
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

describe("isLongPress", () => {
  it("needs the full duration", () => {
    expect(isLongPress(LONG_PRESS_MS - 1, 0, 0)).toBe(false);
    expect(isLongPress(LONG_PRESS_MS, 0, 0)).toBe(true);
  });

  it("is disqualified by a finger that drifted into a gesture", () => {
    expect(isLongPress(LONG_PRESS_MS + 200, -20, 0)).toBe(false);
    expect(isLongPress(LONG_PRESS_MS + 200, 0, -20)).toBe(false);
  });

  it("tolerates the small drift of a stationary finger", () => {
    expect(isLongPress(LONG_PRESS_MS + 50, 3, -3)).toBe(true);
  });
});
