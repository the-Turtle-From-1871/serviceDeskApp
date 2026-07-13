import { describe, it, expect } from "vitest";
import {
  PRIMARY_QUEUE_STATUS,
  READY_TO_ISSUE_STATUS,
  isActiveQueueStatus,
  canRemoveFromQueue,
  statusAfterRemoval,
} from "./service-queue.status";

describe("service-queue status", () => {
  it("primary/service state is PENDING and removed state is READY_TO_ISSUE", () => {
    expect(PRIMARY_QUEUE_STATUS).toBe("PENDING");
    expect(READY_TO_ISSUE_STATUS).toBe("READY_TO_ISSUE");
  });

  it("only PENDING items are active on the queue", () => {
    expect(isActiveQueueStatus("PENDING")).toBe(true);
    expect(isActiveQueueStatus("READY_TO_ISSUE")).toBe(false);
  });

  it("only PENDING items can be removed from the queue", () => {
    expect(canRemoveFromQueue("PENDING")).toBe(true);
    expect(canRemoveFromQueue("READY_TO_ISSUE")).toBe(false);
  });

  it("removal transitions to READY_TO_ISSUE (never a delete)", () => {
    expect(statusAfterRemoval()).toBe("READY_TO_ISSUE");
  });
});
