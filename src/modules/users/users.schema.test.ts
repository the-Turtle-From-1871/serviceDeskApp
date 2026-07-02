import { describe, it, expect } from "vitest";
import { registerSchema } from "./users.schema";

const base = { name: "Jane Soldier", email: "Jane@Unit.Mil", password: "TempPass123" };

describe("registerSchema", () => {
  it("accepts rank/unit/contact and lowercases email; has no role field", () => {
    const r = registerSchema.parse({ ...base, rank: "SGT", unit: "A Co", contactNumber: "808-555-0134" });
    expect(r.email).toBe("jane@unit.mil");
    expect(r.unit).toBe("A Co");
    expect(r.contactNumber).toBe("808-555-0134");
    expect("role" in r).toBe(false);
  });
  it("requires name, email, and an 8+ char password", () => {
    expect(registerSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ email: base.email, password: base.password }).success).toBe(false);
  });
});
