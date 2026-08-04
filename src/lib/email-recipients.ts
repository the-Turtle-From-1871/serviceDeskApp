/**
 * Who is addressed on a custody email (new receipt, return, pickup).
 *
 * All three used to address recipients differently: the new-receipt notice fanned
 * out into a SEPARATE message per party, returns sent one message plus a separate
 * archive copy, and pickup mailed one person with no copy at all. That made "who
 * actually saw this?" unanswerable without reading three files. They now share this
 * module: ONE message per event, to the customer, copying the record addresses.
 *
 * Consequence worth knowing: one message means one delivery outcome. Previously a
 * bad customer address only cost that party their copy, because each send was tried
 * and caught independently. Now a hard rejection can cost everyone the message. The
 * trade is deliberate — recipients can see each other and reply-all, and there is a
 * single thread per receipt rather than N unrelated ones — but it is a real change
 * in failure behaviour, not just formatting.
 */

/**
 * The default record copies. These are organisational fixtures rather than
 * per-deployment configuration, so they ship as defaults and need no env var to
 * work. `RECEIPT_CC_EMAILS` overrides them without a code change.
 *
 * NOTE on the army.mil address: mail to army.mil WAS being silently dropped, and the
 * cause is now known — it was not sender alignment, DKIM or SPF. A controlled
 * four-message test showed plain text, a dcsim.us link and a PDF attachment all
 * arriving, and only the message carrying a `vercel.app` URL disappearing: the
 * government network filters that domain. The fix was pointing APP_URL at
 * https://www.dcsim.us so message bodies stop linking to vercel.app.
 *
 * The consequence for this file: any link placed in a custody email must be built
 * from defaultBaseUrl() (src/lib/base-url.ts), never hardcoded to a deploy URL.
 * A single vercel.app link in a body is enough to make the whole message vanish for
 * .mil recipients, with no bounce and no signal.
 */
export const DEFAULT_RECEIPT_CC_EMAILS = [
  "dcsimservicedesk@gmail.com",
  "ng.hi.hiarng.nbx.dcsim-hand-receipt@army.mil",
];

/** Trim, drop blanks, and de-duplicate case-insensitively, preserving order. */
function normalize(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * The record copies for custody mail.
 *
 * `RECEIPT_CC_EMAILS` is a comma-separated override. Setting it to an EMPTY string
 * is meaningful and disables the copies entirely — distinct from leaving it unset,
 * which uses the defaults. That distinction is why this reads `undefined` rather
 * than falsiness: `RECEIPT_CC_EMAILS=""` must not silently restore the defaults.
 */
export function receiptCcEmails(): string[] {
  const configured = process.env.RECEIPT_CC_EMAILS;
  if (configured === undefined) return [...DEFAULT_RECEIPT_CC_EMAILS];
  return normalize(configured.split(","));
}

/**
 * Address one custody email.
 *
 * @param primary Candidate customer addresses, most-preferred first. The first
 *   usable one becomes `to`; any others are copied rather than dropped, so a
 *   receipt between two outside parties still reaches both.
 * @param extraCc Flow-specific copies (e.g. the G6 desk on a return).
 *
 * `to` is undefined only when there is nobody at all to write to — no customer,
 * no extra copy and no record copy — in which case the caller should skip sending
 * rather than mail nobody. When there is no customer but there ARE copies, the
 * first copy is promoted to `to`, because a message with only CC recipients is
 * treated as suspicious by several gateways.
 */
export function addressCustodyEmail(
  primary: (string | null | undefined)[],
  extraCc: (string | null | undefined)[] = [],
): { to: string | undefined; cc: string[] | undefined } {
  const candidates = normalize(primary);
  const copies = normalize([...candidates.slice(1), ...extraCc, ...receiptCcEmails()]);

  let to = candidates[0];
  let cc = copies;
  if (!to) {
    to = copies[0];
    cc = copies.slice(1);
  }

  if (!to) return { to: undefined, cc: undefined };

  const toKey = to.toLowerCase();
  cc = cc.filter((address) => address.toLowerCase() !== toKey);
  return { to, cc: cc.length ? cc : undefined };
}
