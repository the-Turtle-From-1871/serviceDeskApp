import { describe, it, expect } from "vitest";
import { newSignatureSchema } from "./signatures.schema";

const PNG = "data:image/png;base64,AAAA";

describe("newSignatureSchema", () => {
  it("accepts a name and a PNG data URL, trimming the name", () => {
    const parsed = newSignatureSchema.parse({ name: "  SGT Smith  ", image: PNG });
    expect(parsed).toEqual({ name: "SGT Smith", image: PNG });
  });

  it("requires a name", () => {
    expect(newSignatureSchema.safeParse({ name: "   ", image: PNG }).success).toBe(false);
  });

  it("rejects a non-PNG image via the shared signatureError validator", () => {
    const r = newSignatureSchema.safeParse({ name: "SGT Smith", image: "data:image/jpeg;base64,AAAA" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty image", () => {
    expect(newSignatureSchema.safeParse({ name: "SGT Smith", image: "" }).success).toBe(false);
  });
});
