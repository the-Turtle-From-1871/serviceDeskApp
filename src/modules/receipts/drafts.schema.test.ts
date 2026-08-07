import { describe, it, expect } from "vitest";
import { receiptDraftSchema, draftLabel } from "./drafts.schema";

describe("receiptDraftSchema", () => {
  it("accepts a completely empty form (that is what a draft IS)", () => {
    const r = receiptDraftSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.itemIds).toEqual([]);
    expect(r.data!.sender.name).toBe("");
    expect(r.data!.receiver.isDcsim).toBe(false);
  });

  it("keeps blank strings rather than collapsing them to undefined", () => {
    const r = receiptDraftSchema.parse({ receiver: { name: "  " } });
    expect(r.receiver.name).toBe("");
  });

  it("strips unknown keys so a crafted POST cannot smuggle fields in", () => {
    const r = receiptDraftSchema.parse({ receiverSignature: "data:image/png;base64,AAA", evil: 1 });
    expect(r).not.toHaveProperty("receiverSignature");
    expect(r).not.toHaveProperty("evil");
  });

  it("rejects an over-long string", () => {
    expect(receiptDraftSchema.safeParse({ receiver: { name: "x".repeat(201) } }).success).toBe(false);
  });

  it("rejects more itemIds than a receipt could ever hold", () => {
    const ids = Array.from({ length: 181 }, (_, i) => `i${i}`);
    expect(receiptDraftSchema.safeParse({ itemIds: ids }).success).toBe(false);
  });

  it("rejects more lines than MAX_RECEIPT_ROWS", () => {
    const lines = Array.from({ length: 19 }, () => ({ make: "Dell", model: "5420" }));
    expect(receiptDraftSchema.safeParse({ lines }).success).toBe(false);
  });

  it("keeps quantities as typed strings, not numbers", () => {
    const r = receiptDraftSchema.parse({ lines: [{ make: "Dell", model: "5420", qtyAuth: "2", qtyIssued: "" }] });
    expect(r.lines[0].qtyAuth).toBe("2");
    expect(r.lines[0].qtyIssued).toBe("");
  });

  it("rejects an unknown service type", () => {
    const service = [{ itemId: "i1", serviceType: "LASER" }];
    expect(receiptDraftSchema.safeParse({ service }).success).toBe(false);
  });
});

describe("draftLabel", () => {
  it("uses the recipient name and item count", () => {
    const p = receiptDraftSchema.parse({ receiver: { name: "Doe, Jane" }, itemIds: ["a", "b"] });
    expect(draftLabel(p)).toBe("Doe, Jane · 2 items");
  });

  it("singularises one item", () => {
    const p = receiptDraftSchema.parse({ receiver: { name: "Doe, Jane" }, itemIds: ["a"] });
    expect(draftLabel(p)).toBe("Doe, Jane · 1 item");
  });

  it("falls back when no recipient has been typed yet", () => {
    const p = receiptDraftSchema.parse({ itemIds: ["a"] });
    expect(draftLabel(p)).toBe("No recipient yet · 1 item");
  });
});
