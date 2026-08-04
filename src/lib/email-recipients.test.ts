import { describe, it, expect, afterEach } from "vitest";
import { addressCustodyEmail, receiptCcEmails, DEFAULT_RECEIPT_CC_EMAILS } from "./email-recipients";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("receiptCcEmails", () => {
  it("uses the built-in defaults when RECEIPT_CC_EMAILS is unset", () => {
    delete process.env.RECEIPT_CC_EMAILS;
    expect(receiptCcEmails()).toEqual(DEFAULT_RECEIPT_CC_EMAILS);
  });

  it("returns a copy, so a caller cannot mutate the defaults for everyone else", () => {
    delete process.env.RECEIPT_CC_EMAILS;
    const first = receiptCcEmails();
    first.push("intruder@example.com");
    expect(receiptCcEmails()).toEqual(DEFAULT_RECEIPT_CC_EMAILS);
  });

  it("an EMPTY value disables the copies rather than restoring the defaults", () => {
    // The distinction matters: "" is an explicit opt-out and must not be confused
    // with "unset", which means "use the defaults".
    process.env.RECEIPT_CC_EMAILS = "";
    expect(receiptCcEmails()).toEqual([]);
  });

  it("splits, trims and de-duplicates a configured list", () => {
    process.env.RECEIPT_CC_EMAILS = " a@x.mil , b@x.mil ,, A@X.MIL ,b@x.mil ";
    expect(receiptCcEmails()).toEqual(["a@x.mil", "b@x.mil"]);
  });
});

describe("addressCustodyEmail", () => {
  it("puts the first customer on To and the record copies on CC", () => {
    delete process.env.RECEIPT_CC_EMAILS;
    expect(addressCustodyEmail(["jane@u.mil"])).toEqual({
      to: "jane@u.mil",
      cc: DEFAULT_RECEIPT_CC_EMAILS,
    });
  });

  it("copies a second customer rather than dropping them", () => {
    process.env.RECEIPT_CC_EMAILS = "";
    expect(addressCustodyEmail(["a@u.mil", "b@u.mil"])).toEqual({ to: "a@u.mil", cc: ["b@u.mil"] });
  });

  it("skips null and blank candidates without shifting the wrong person onto To", () => {
    process.env.RECEIPT_CC_EMAILS = "";
    expect(addressCustodyEmail([null, "   ", undefined, "real@u.mil"])).toEqual({ to: "real@u.mil", cc: undefined });
  });

  it("never CCs the same address it is sending to, whatever the casing", () => {
    process.env.RECEIPT_CC_EMAILS = "Jane@U.MIL,desk@x.mil";
    expect(addressCustodyEmail(["jane@u.mil"])).toEqual({ to: "jane@u.mil", cc: ["desk@x.mil"] });
  });

  it("de-duplicates an extra copy that is also a record copy", () => {
    process.env.RECEIPT_CC_EMAILS = "records@x.mil";
    expect(addressCustodyEmail(["jane@u.mil"], ["records@x.mil"])).toEqual({
      to: "jane@u.mil",
      cc: ["records@x.mil"],
    });
  });

  it("promotes the first copy to To when there is no customer", () => {
    // A message with only CC recipients is treated as suspicious by several
    // gateways, so something must occupy the To line.
    process.env.RECEIPT_CC_EMAILS = "one@x.mil,two@x.mil";
    expect(addressCustodyEmail([null])).toEqual({ to: "one@x.mil", cc: ["two@x.mil"] });
  });

  it("orders extra copies before the record copies", () => {
    process.env.RECEIPT_CC_EMAILS = "records@x.mil";
    expect(addressCustodyEmail(["jane@u.mil"], ["desk@x.mil"])).toEqual({
      to: "jane@u.mil",
      cc: ["desk@x.mil", "records@x.mil"],
    });
  });

  it("returns no recipient at all when there is genuinely nobody to write to", () => {
    process.env.RECEIPT_CC_EMAILS = "";
    expect(addressCustodyEmail([null, undefined], [undefined])).toEqual({ to: undefined, cc: undefined });
  });
});
