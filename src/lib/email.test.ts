import { describe, it, expect, afterEach } from "vitest";
import { getEmailSender } from "./email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("getEmailSender", () => {
  it("returns the logging stub when no email env is present", () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });
  it("returns the Resend sender when env is present", () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });
  it("returns the Gmail sender when Gmail env is present", () => {
    process.env.GMAIL_USER = "dcsimservicedesk@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(getEmailSender().constructor.name).toBe("GmailEmailSender");
  });
  it("prefers Gmail over Resend when both are configured", () => {
    process.env.GMAIL_USER = "dcsimservicedesk@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("GmailEmailSender");
  });
});
