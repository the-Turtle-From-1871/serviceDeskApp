import { describe, it, expect } from "vitest";
import {
  PRIMARY_QUEUE_STATUS,
  COMPLETED_STATUS,
  isActiveQueueStatus,
  canComplete,
  canReopen,
  serviceTypeLabel,
} from "./service-queue.status";

describe("service-queue status", () => {
  it("primary state is PENDING and done state is COMPLETED", () => {
    expect(PRIMARY_QUEUE_STATUS).toBe("PENDING");
    expect(COMPLETED_STATUS).toBe("COMPLETED");
  });

  it("only PENDING items are active on the queue", () => {
    expect(isActiveQueueStatus("PENDING")).toBe(true);
    expect(isActiveQueueStatus("COMPLETED")).toBe(false);
  });

  it("only PENDING can be completed; only COMPLETED can be reopened", () => {
    expect(canComplete("PENDING")).toBe(true);
    expect(canComplete("COMPLETED")).toBe(false);
    expect(canReopen("COMPLETED")).toBe(true);
    expect(canReopen("PENDING")).toBe(false);
  });
});

describe("serviceTypeLabel", () => {
  it("labels the fixed types", () => {
    expect(serviceTypeLabel("REIMAGE", null)).toBe("Reimage");
    expect(serviceTypeLabel("REPAIR", null)).toBe("Repair");
  });

  it("shows the custom note for OTHER, trimmed", () => {
    expect(serviceTypeLabel("OTHER", "  Screen cracked ")).toBe("Screen cracked");
  });

  it("falls back to 'Other' when OTHER has no note", () => {
    expect(serviceTypeLabel("OTHER", null)).toBe("Other");
    expect(serviceTypeLabel("OTHER", "   ")).toBe("Other");
  });
});
