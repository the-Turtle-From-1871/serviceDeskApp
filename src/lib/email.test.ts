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
    delete process.env.GMAIL_REFRESH_TOKEN;
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });
  it("prefers the Gmail sender when Gmail env is present (over Resend)", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    process.env.GMAIL_FROM = "DCSIM Service Desk <dcsimservicedesk@gmail.com>";
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "rt";
    expect(getEmailSender().constructor.name).toBe("GmailEmailSender");
  });
});
