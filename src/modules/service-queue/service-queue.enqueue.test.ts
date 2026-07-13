import { describe, it, expect } from "vitest";
import { toQueueItemCreateData } from "./service-queue.enqueue";

describe("toQueueItemCreateData", () => {
  it("maps a transfer id to a PENDING primary-queue entry", () => {
    expect(toQueueItemCreateData("t_123")).toEqual({ transferId: "t_123", status: "PENDING" });
  });

  it("routes every receipt into the primary state regardless of id", () => {
    for (const id of ["a", "b", "c"]) {
      expect(toQueueItemCreateData(id).status).toBe("PENDING");
    }
  });
});
