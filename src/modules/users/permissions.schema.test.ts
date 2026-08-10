import { describe, expect, it } from "vitest";
import { permissionDecisionSchema, permissionRequestSchema } from "./permissions.schema";

const REASON = "I have taken over returns processing for the shop this quarter.";

describe("permissionRequestSchema", () => {
  it("accepts a real request", () => {
    const parsed = permissionRequestSchema.parse({
      justification: REASON,
      capabilities: ["PROCESS_RETURNS"],
    });
    expect(parsed.capabilities).toEqual(["PROCESS_RETURNS"]);
  });

  // There is no minimum. The 20-character floor refused the short-but-real
  // reasons people actually type ("taking over returns"), and a request never
  // filed is worse for the admin than a thin one they can weigh.
  it("accepts a justification of any length", () => {
    const parsed = permissionRequestSchema.parse({
      justification: "pls",
      capabilities: ["PROCESS_RETURNS"],
    });
    expect(parsed.justification).toBe("pls");
  });

  it("accepts an empty justification", () => {
    expect(
      permissionRequestSchema.parse({ justification: "", capabilities: ["PROCESS_RETURNS"] })
        .justification,
    ).toBe("");
  });

  // Trimmed to "" rather than kept as spaces, so the two surfaces that render
  // it can test for emptiness and show "No reason given" instead of a quoted
  // blank.
  it("collapses a whitespace-only justification to empty", () => {
    expect(
      permissionRequestSchema.parse({
        justification: " ".repeat(50),
        capabilities: ["PROCESS_RETURNS"],
      }).justification,
    ).toBe("");
  });

  it("defaults an omitted justification to empty rather than throwing", () => {
    expect(
      permissionRequestSchema.parse({ capabilities: ["PROCESS_RETURNS"] }).justification,
    ).toBe("");
  });

  it("still rejects a justification past the length cap", () => {
    expect(
      permissionRequestSchema.safeParse({
        justification: "x".repeat(2001),
        capabilities: ["PROCESS_RETURNS"],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty capability list", () => {
    expect(
      permissionRequestSchema.safeParse({ justification: REASON, capabilities: [] }).success,
    ).toBe(false);
  });

  // Everyone already holds it, so asking is meaningless — and letting it
  // through would put a permanently-unresolvable line in the admin queue.
  it("rejects VIEW_INVENTORY, which is not requestable", () => {
    expect(
      permissionRequestSchema.safeParse({
        justification: REASON,
        capabilities: ["VIEW_INVENTORY"],
      }).success,
    ).toBe(false);
  });

  it("rejects a capability that does not exist", () => {
    expect(
      permissionRequestSchema.safeParse({ justification: REASON, capabilities: ["ROOT"] }).success,
    ).toBe(false);
  });

  // Requestable but elevated — the danger treatment is a UI concern, not a
  // validation one.
  it("accepts ADMINISTER", () => {
    expect(
      permissionRequestSchema.safeParse({ justification: REASON, capabilities: ["ADMINISTER"] })
        .success,
    ).toBe(true);
  });

  it("dedupes a repeated capability rather than failing the write later", () => {
    const parsed = permissionRequestSchema.parse({
      justification: REASON,
      capabilities: ["MANAGE_QUEUE", "MANAGE_QUEUE"],
    });
    expect(parsed.capabilities).toEqual(["MANAGE_QUEUE"]);
  });
});

describe("permissionDecisionSchema", () => {
  it("treats a missing approve list as a full denial, not a parse error", () => {
    const parsed = permissionDecisionSchema.parse({ requestId: "r1", denialReason: "No." });
    expect(parsed.approve).toEqual([]);
  });

  it("accepts an approve-everything decision with no reason", () => {
    const parsed = permissionDecisionSchema.parse({
      requestId: "r1",
      approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    expect(parsed.denialReason).toBeUndefined();
  });

  it("dedupes the approve list", () => {
    const parsed = permissionDecisionSchema.parse({
      requestId: "r1",
      approve: ["MANAGE_QUEUE", "MANAGE_QUEUE"],
    });
    expect(parsed.approve).toEqual(["MANAGE_QUEUE"]);
  });

  it("requires a request id", () => {
    expect(permissionDecisionSchema.safeParse({ requestId: "", approve: [] }).success).toBe(false);
  });
});
