# Gmail OAuth sender (Gmail API v1, `gmail.send`)

**Date:** 2026-07-31
**Status:** Approved, not yet implemented

## 1. What this changes

Replace the outbound-mail transport. Today the app sends as `dcsimservicedesk@gmail.com`
over SMTP with a Google **app password** (`GmailEmailSender`, `src/lib/email.ts:47`).
After this change it sends as the same account through the **Gmail API v1**
(`users.messages.send`) authenticated with an **OAuth2 refresh token**, scope
`https://www.googleapis.com/auth/gmail.send`.

Every caller is untouched. All six senders — new receipt, return, pickup, password
reset, and the two timer alerts — resolve their transport through `getEmailSender()`
and speak the existing `EmailSender` interface.

## 2. Decision record — what this does and does not fix

This was requested to fix `.mil` deliverability: mail sent by hand from the Gmail web
UI reaches `army.mil` recipients, mail sent by the app does not, and the working
theory was that the app's mail lacks a signature or certification that OAuth would
supply.

**That theory is not correct, and this document records it so the question is not
reopened a third time.** DKIM signing is applied by Google's outbound MTAs at relay
time. It is identical whether the message was composed in the Gmail web UI, handed to
`smtp.gmail.com` with an app password, or submitted to the Gmail API over OAuth. All
three emit `From: …@gmail.com` with `DKIM-Signature d=gmail.com` and an SPF pass on
Google's IPs. The receiving gateway cannot observe how the sender authenticated to
Google — that exchange completes before the message leaves Google's network. OAuth is
an authorization mechanism, not a signing mechanism; no certificate or S/MIME is
involved anywhere in this path.

This same conclusion was reached once before: the Gmail API sender was built as
`16cb793` (2026-07-10) and reverted as `6b88609` the same day.

The likelier causes of the `.mil` drop, neither addressed here, are:

- **The PDF attachment.** The app attaches the signed hand receipt; hand-sent test
  messages may not. DoD gateways quarantine attachments aggressively.
- **The link in the body.** Receipt mail contains a link built from `APP_URL`. The
  government network is recorded as DNS-sinkholing `*.vercel.app` (see `487a588`). A
  body linking to a sinkholed domain is a routine cause of a silent drop.

The change that would genuinely alter sender identity is Google Workspace on
`dcsim.us` with DKIM enabled, producing `d=dcsim.us` aligned to the app's own domain.
That remains the open lever and is out of scope here.

**Proceeding anyway is a deliberate, informed decision by the project owner.** It buys
one real benefit independent of deliverability: it removes the dependency on Google app
passwords, which Google has been progressively retiring, and gives cleaner credential
rotation.

## 3. Goals / non-goals

**Goals**

- Send via Gmail API v1 with an OAuth2 refresh token, scope `gmail.send`.
- Exactly one Gmail transport in the codebase; the app-password path is removed.
- No new npm dependencies.
- Preserve every current message feature, including the HTML body the reverted
  implementation silently dropped.
- Fail loudly and identifiably when the refresh token dies.

**Non-goals**

- Fixing `.mil` deliverability (see §2).
- Migrating the sending identity to `dcsim.us` / Workspace.
- Touching the Resend sender or the log stub.
- Any change to message copy, recipients, or when mail is sent.

## 4. Architecture

New leaf module `src/lib/gmail-oauth-email.ts`:

```ts
export function buildRawEmail(msg: EmailMessage, from: string, boundary?: string): string
export type GmailOAuthConfig = { from, clientId, clientSecret, refreshToken }
export class GmailOAuthSender implements EmailSender
export function gmailOAuthConfigFromEnv(): GmailOAuthConfig | null
```

Implementation is `fetch` + `node:crypto` only — the Gmail REST endpoint takes a
base64url-encoded RFC 2822 message in a `raw` field, so the `googleapis` package
(large, and subject to the supply-chain rule in CLAUDE.md §3) buys nothing.

`getEmailSender()` precedence becomes:

| Condition | Sender |
| --- | --- |
| `GMAIL_FROM` + `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN` | `GmailOAuthSender` |
| `RESEND_API_KEY` + `EMAIL_FROM` | `ResendEmailSender` |
| otherwise | `LogEmailSender` |

Selection is by **env presence only, never by send failure** (§7).

`GmailEmailSender` (SMTP/app password), its two env vars, and its tests are deleted.
`nodemailer` stays in `package.json` — verify no other importer before considering its
removal; that is not part of this change.

## 5. The MIME builder

`buildRawEmail` is restored from `16cb793` with four defects fixed. Each gets a
failing-first test.

### 5.1 Restore the HTML body (regression fix)

The reverted implementation ignored `EmailMessage.html` entirely.
`send-password-reset-email.ts` sets it — a styled body with a real reset button —
so shipping `16cb793` verbatim would degrade password-reset mail to plain text and
lose the button. Required structure:

| Message content | Top-level type |
| --- | --- |
| text only | `text/plain; charset="UTF-8"` |
| text + html | `multipart/alternative` |
| text + attachments | `multipart/mixed` |
| text + html + attachments | `multipart/mixed` wrapping a `multipart/alternative` first part |

Nested parts require a second, distinct boundary token.

### 5.2 Header injection guard

`subject`, `to`, `cc` and attachment `filename` are interpolated into header lines. A
`\r` or `\n` in any of them forges arbitrary headers (extra `Bcc:`, a replaced body).
Strip CR and LF from every value at the point it enters a header. This is the same bug
class as the tracked `nodemailer` CRLF advisory, in code we own.

### 5.3 RFC 2047 subject encoding

A non-ASCII subject is invalid raw in a header. Device, unit and person names can
carry non-ASCII. Encode as `=?UTF-8?B?<base64>?=` when the subject is not pure ASCII;
leave pure-ASCII subjects untouched so existing output is unchanged.

### 5.4 Attachment content type

Hardcoded `application/pdf`. True of every current caller, but a latent trap. Derive
from the filename extension; default `application/octet-stream`.

Retained from the original: base64 payloads wrapped at 76 characters (RFC 2045), CRLF
line endings throughout, base64url with stripped padding for the `raw` field.

## 6. Access-token cache

The reverted implementation exchanged the refresh token for an access token **on every
send**. `sendReceiptEmails` fans out to as many as three recipients through
`Promise.all`, so one receipt cost three token round-trips.

Module-scoped cache holding the access token and its absolute expiry, computed from
`expires_in` with a 60-second safety margin. A single in-flight refresh promise is
shared, so N concurrent sends trigger one exchange rather than racing N. The cache is
per serverless instance; that is correct and needs no coordination, since an access
token is freely re-mintable.

## 7. Failure behavior

A refresh token dies from: the 7-day Testing-status expiry (§9), user revocation, an
account password change, 6 months of disuse, or exceeding 100 live tokens per client.

Google reports all of these as HTTP 400 `{"error":"invalid_grant"}`. That is mapped to
a distinctly worded thrown error naming the likely cause and the remedy, so it is
greppable in Vercel logs rather than reading as a generic 400.

**No fallback to another transport on send failure.** Silently degrading would hide
exactly the failure this design must make visible.

`sendReceiptEmails` continues to catch and swallow per-recipient failures so a mail
outage never rolls back a completed transfer — unchanged; the distinct message is what
makes the log line actionable.

## 8. Configuration

| Var | Meaning |
| --- | --- |
| `GMAIL_FROM` | `From` header, e.g. `DCSIM Service Desk <dcsimservicedesk@gmail.com>`. Address must be the authenticated account or one of its verified "Send mail as" aliases. |
| `GMAIL_CLIENT_ID` | OAuth client id (project `dcsim-hand-receipt`). |
| `GMAIL_CLIENT_SECRET` | OAuth client secret. |
| `GMAIL_REFRESH_TOKEN` | Offline refresh token for the sending account. |

Removed: `GMAIL_USER`, `GMAIL_APP_PASSWORD`.

## 9. Google Cloud console prerequisite (manual)

Per Google's OAuth documentation: *projects in 'Testing' status with external user
types have refresh tokens that expire in 7 days*, unless only basic profile scopes are
requested. `gmail.send` is not a basic profile scope.

**AMENDED 2026-07-31, by owner decision: the consent screen stays in Testing.** An
earlier revision of this section made "In production" a blocking prerequisite. It is
not. The 7-day expiry is accepted as an operating cost and handled by separate rotation
tooling (`2026-07-31-gmail-token-rotation-design.md`), because publishing to production
with a sensitive scope invites a verification review the project does not want to enter
yet.

The consequence must be stated plainly wherever a reader could mistake it for a fault:
**the refresh token dies about weekly, and a person has to re-mint it and push it to
Vercel.** With no fallback transport (§7), outbound mail stops until they do. Every
artifact this design touches — the `invalid_grant` error string, `.env.example`,
`docs/SECURITY.md`, the changelog — says so in those terms. An error message that reads
"set it to In production" would send the next reader to undo a deliberate decision.

Required before this ships:

1. Enable the Gmail API in project `dcsim-hand-receipt`.
2. Leave publishing status at **Testing**, and confirm the sending account is listed as
   a **test user** — a Testing-status app issues tokens only to those.
3. Mint the refresh token via the OAuth Playground (the client's registered redirect
   URI), scope `https://www.googleapis.com/auth/gmail.send`, offline access.

`gmail.send` is classified **sensitive**, not restricted, so it needs consent-screen
verification but not the annual third-party CASA security assessment that
`https://mail.google.com/` (the scope SMTP XOAUTH2 would have required) triggers.

The `credentials.json` currently in `~/Downloads` contains a live client secret. Once
the values are in Vercel, delete the file; rotate the secret if it has been shared.

## 10. Deploy ordering (blocking rule)

Removing the SMTP sender makes **Resend the accidental fallback**: `RESEND_API_KEY` and
`EMAIL_FROM` are both still set in production, so code that merges before the OAuth
vars exist will fall straight through to Resend — which this project's history records
as failing SPF from `turtolabs.com`. That failure is silent: mail is accepted and never
arrives.

**Therefore: set `GMAIL_FROM` / `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` /
`GMAIL_REFRESH_TOKEN` in Vercel production before the PR merges.** Same spirit as this
repo's migrate-before-push rule. Verify with `vercel env ls production`.

## 11. Testing

All tests stub `fetch`; nothing reaches Google in CI.

**`buildRawEmail`** — plain text only; text+html is `multipart/alternative`;
text+attachment is `multipart/mixed`; text+html+attachment nests correctly with
distinct boundaries; CR/LF stripped from subject, `to`, `cc`, and filename;
non-ASCII subject RFC 2047 encoded and pure-ASCII left alone; content type derived
from extension; base64 wrapped at 76 columns; output is valid base64url.

**Token cache** — one exchange for N concurrent sends; re-exchange after expiry;
cached token reused inside the window.

**Failure mapping** — `invalid_grant` produces the distinct error; a non-400 send
failure surfaces status and body.

**`getEmailSender()`** — extend the existing table in `email.test.ts` for the new
precedence, including the removal of the app-password cases.

## 12. Documentation obligations (same commit)

- `.env.example` — add the four vars, remove the two app-password vars.
- `CHANGELOG.md` — entry under `## 2026-07-31`, **Changed** (transport) and
  **Security** (header-injection guard), with a **Notes** subsection covering the
  console prerequisite in §9 and the deploy ordering in §10.
- `docs/SECURITY.md` — `GMAIL_REFRESH_TOKEN` is a new long-lived credential; the
  header-injection guard is a new control; the app-password entry is removed. Bump
  *Last reviewed*.
- `scripts/check-security-docs.mjs` — add `src/lib/gmail-oauth-email.ts` to `WATCHED`.
  An outbound-mail header builder holding a long-lived credential should not be able to
  change without the security doc changing. Note `check-security-docs.test.mjs` asserts
  the list stays complete.
- `CLAUDE.md` — no existing rule contradicts this change; confirm during
  implementation and add a transport note only if one is found.

Branch → PR → the three required checks (`Semgrep SAST`, `Build (next build)`,
`Security docs current`) → merge.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| `.mil` delivery is unchanged | Recorded in §2 as expected. Re-test after deploy; if unchanged, the next lever is the attachment/link content test, then Workspace on `dcsim.us`. |
| Refresh token expires weekly (Testing status, accepted §9) | §7 makes the failure loud and names the remedy. Mitigated by the separate rotation tooling. Residual: mail is down between expiry and rotation — this is the accepted cost of the decision, and it is the strongest argument for revisiting In production later. |
| Code merges before env vars exist → silent Resend fallback | §10 blocking rule; verify with `vercel env ls production`. |
| Refresh token dies with no fallback | Deliberate. Rollback is restoring the app-password sender from git and re-adding two env vars. |
| Hand-built MIME is subtly malformed | §11 covers structure; verify a real send with an attachment and an HTML body against a mailbox we control before merging. |
