import { describe, it, expect } from "vitest";
import { formatPhone } from "./phone";

describe("formatPhone", () => {
  it("formats progressively toward (xxx)-xxx-xxxx", () => {
    expect(formatPhone("")).toBe("");
    expect(formatPhone("1")).toBe("(1");
    expect(formatPhone("12")).toBe("(12");
    expect(formatPhone("123")).toBe("(123");
    expect(formatPhone("1234")).toBe("(123)-4");
    expect(formatPhone("123456")).toBe("(123)-456");
    expect(formatPhone("1234567")).toBe("(123)-456-7");
    expect(formatPhone("1234567890")).toBe("(123)-456-7890");
  });

  it("strips non-digits and caps at 10 digits", () => {
    expect(formatPhone("abc123def456ghi78901234")).toBe("(123)-456-7890");
    expect(formatPhone("808-555-0100")).toBe("(808)-555-0100");
    expect(formatPhone("(123)-456-7890")).toBe("(123)-456-7890");
  });

  it("does not append a closing paren until there is a fourth digit (so backspace works)", () => {
    // Re-formatting the 3-digit state must be stable (no sticky paren).
    expect(formatPhone(formatPhone("123"))).toBe("(123");
  });
});
