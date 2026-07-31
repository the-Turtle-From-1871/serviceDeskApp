import { describe, it, expect, afterEach } from "vitest";
import { getEmailSender } from "./email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("getEmailSender", () => {
  function clearAll() {
    for (const k of [
      "RESEND_API_KEY", "EMAIL_FROM",
      "GMAIL_FROM", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
      "GMAIL_USER", "GMAIL_APP_PASSWORD",
    ]) delete process.env[k];
  }
  function setOAuth() {
    process.env.GMAIL_FROM = "DCSIM Service Desk <dcsimservicedesk@gmail.com>";
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "rtok";
  }

  it("returns the logging stub when no email env is present", () => {
    clearAll();
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });

  it("returns the Resend sender when only Resend env is present", () => {
    clearAll();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });

  it("returns the Gmail OAuth sender when all four OAuth vars are present", () => {
    clearAll();
    setOAuth();
    expect(getEmailSender().constructor.name).toBe("GmailOAuthSender");
  });

  it("prefers Gmail OAuth over Resend when both are configured", () => {
    clearAll();
    setOAuth();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("GmailOAuthSender");
  });

  it("falls through when the OAuth config is incomplete", () => {
    clearAll();
    setOAuth();
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });

  // The app-password transport is gone: these vars must no longer select a
  // sender, or a stale Vercel env would silently keep the old path alive.
  it("ignores the retired app-password vars", () => {
    clearAll();
    process.env.GMAIL_USER = "dcsimservicedesk@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });
});
