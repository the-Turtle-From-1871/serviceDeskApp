import { describe, it, expect, afterEach } from "vitest";
import { getEmailSender } from "./email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("getEmailSender", () => {
  it("returns the logging stub when Resend env is absent", () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });
  it("returns the Resend sender when env is present", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });
});
