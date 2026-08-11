# Web push notifications for home-screen installs

**Date:** 2026-08-11
**Status:** Design approved, not yet planned

## Problem

Three classes of thing go unnoticed today:

1. **Work waiting on a person.** A filed permission request notifies nobody — an admin
   discovers it by visiting `/admin/permissions`. Every service-queue transition
   (flagged, deadline set, completed, reopened) is likewise silent.
2. **Activity on a device someone cares about.** There is no way to follow a single
   device; you re-open `/i/<id>` and look.
3. **Timers.** `sendOverdueTransferAlerts` and `sendOverdueServiceAlerts` fire nightly
   from `/api/cron/purge`, but only to the shared `ADMIN_INBOX_EMAIL` — a mailbox no
   individual owns. "Due soon" (the 3-day `DUE_SOON_DAYS` window in
   `src/modules/timers/due.ts`) is a UI badge with no notification at all.

The app is already installed to iOS home screens, which is the precondition for Web
Push on iOS 16.4+. Delivery is free and vendor-less: browser push services (Apple,
Google, Mozilla) require no account, and identity is a self-issued VAPID keypair. No
Apple Developer account, no Firebase, no OneSignal.

## Scope

Push **covers only events that are silent today**. The five existing email paths
(receipt filed, partial return, full return/closed, pickup ready, permission decision)
are unchanged, and **no recipient ever receives the same event on both channels** — so
there is nothing to de-duplicate and no "why did I get this twice".

Note the distinction this turns on: filing a receipt emails the **parties** to it, while
the same act pushes to anyone **watching** one of the devices on it. Same event, disjoint
audiences. If a watcher happens to also be a party, suppress the push — the email is the
record.

### Out of scope for v1

- Any change to existing email behaviour.
- In-app inbox or notification history.
- Quiet hours / digest scheduling beyond the daily cron.
- Anything for logged-out receipt recipients — they never install the app, so push
  cannot reach them. Email remains their only channel.
- Retry queue. A failed push is dropped; email is the durable channel where one exists.

## Design principle: one push per action or per sweep, never per row

A receipt with ten DCSIM items calls `upsertServiceRequest` ten times. Ten
notifications for one action is how people permanently disable notifications. Every
trigger below collapses to a single notification carrying a count.

## Events, recipients, defaults

### Category A — "Someone's waiting on you" · default ON

| Event | Recipients | Notification |
|---|---|---|
| Permission request filed (`requestPermissionsAction`) | `ADMINISTER` holders, minus the requester | "Permission request from &lt;name&gt;" → `/admin/permissions` |
| Item(s) flagged for service (`upsertServiceRequest`, both call sites) | `MANAGE_QUEUE` holders, minus the actor | "3 devices flagged for service" → `/admin/queue` |

### Category B — "Timers" · default OFF

Fires from the existing nightly `/api/cron/purge` job (GitHub Actions,
`purge-cron.yml`, 08:23 UTC). One digest push per category, not one per item.

| Event | Recipients | Notification |
|---|---|---|
| Service due-soon (3d) + overdue | `MANAGE_QUEUE` holders | "2 services overdue, 4 due soon" → `/admin/queue` |
| Transfer overdue | `ADMINISTER` holders | "3 hand receipts overdue" → `/receipts` |

The existing `overdueAlertedAt` stamps keep the **email** one-shot and are not touched.
The push digest deliberately re-sends while the condition holds — it is a standing
reminder, and it is one notification per day regardless of count. **No new stamp
column.**

### Category C — "Watched devices" · default ON (silent until you watch something)

A "Watch" toggle on `/i/<id>` writes a `WatchedItem` row. Watchers, minus the actor,
are notified when a watched device is:

- added to a new receipt,
- returned (partial or full),
- edited (`updateItemDetailsAction` / `updateItemAction` / `updateItemIdentityAction`),
- marked serviced / ready,
- audited.

Link target is `/i/<id>`. Recipients are re-checked for `VIEW_INVENTORY` at send time,
so a demoted account stops receiving without any cleanup step.

### Category D — "Data quality" · default OFF

Daily digest to `MANAGE_ITEMS` holders after the Drive import cron
(`drive-import-cron.yml`, 09:17 UTC): "Import: 12 added, 3 mismatches, 5 devices need a
rename."

Audit-overdue is included but counts **only devices that crossed the one-year line in
the last 24h** — derivable from `lastAuditedAt` against `auditCutoff`, no new column. A
running total would re-send the same 18 devices every night forever, which is noise
pretending to be a reminder.

### Preferences

Four toggles on `/account`, stored as four booleans on `User`:

| Column | Default |
|---|---|
| `notifyAdminQueue` | `true` |
| `notifyTimers` | `false` |
| `notifyWatched` | `true` |
| `notifyDataQuality` | `false` |

Per-**user**, not per-device, so a phone and a laptop stay in sync. The toggle is
checked at **send** time alongside the capability, so it is the throttle and there is no
hardcoded recipient list anywhere in the codebase.

### Payload content

Notifications render on a lock screen, which is a wider audience than the app. Payloads
are **PII-minimal**: counts, device names and a URL. Never a holder's name, and never a
serial number — even though serials are public by accepted requirement, a lock screen is
not the surface that decision was made for.

## Architecture

### Service worker

`public/sw.js`, served at `/sw.js` (scope `/`). Exactly two listeners:

- `push` → `self.registration.showNotification(...)`
- `notificationclick` → `clients.openWindow(...)`

**No `fetch` handler.** This is what reconciles the feature with the standing rule that
this app has no offline cache: a worker with no `fetch` listener never intercepts a
request and therefore cannot serve a stale property book. The rule narrows from "no
service worker" to "no `fetch` handler, no offline cache".

**`/sw.js` must be added to the matcher exclusion list in `src/proxy.ts:481`**, beside
`manifest.webmanifest`, `icon` and `apple-icon`. It is matched today, so the coarse
login gate would hand a logged-out install HTML where it expects JavaScript — a silently
dead worker with no error anywhere. Pinned in `proxy.test.ts` exactly as the icon routes
are.

### Schema

```prisma
model PushSubscription {
  id         String   @id @default(cuid())
  userId     String
  endpoint   String   @unique
  p256dh     String
  auth       String
  userAgent  String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime?
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model WatchedItem {
  userId    String
  itemId    String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  item      Item     @relation(fields: [itemId], references: [id], onDelete: Cascade)

  @@id([userId, itemId])
  @@index([itemId])
}
```

Plus the four boolean columns on `User`. Both new tables cascade-delete with the user,
so the existing account-purge worker cleans up for free.

### Module split

`src/modules/notifications/`, following the repo convention:

- **`categories.ts` — pure, no Prisma import.** The category enum, the default map, and
  the category → required-capability mapping. Unit-tested directly, exactly like
  `capabilities.ts`.
- **`push.service.ts`** — the only file that touches the DB and `web-push`.

### Recipient resolution

Two traps, both avoided:

- **The role→capability rule is never re-expressed in SQL.** One `findMany` loads active
  users who have at least one subscription and the relevant category toggle set, then
  filters in TypeScript through `capabilitiesForUser()`. `capabilities.ts` stays the
  single definition.
- **No N+1.** One query for recipients (with subscriptions included), then one
  `Promise.allSettled` over the resulting subscription list. The list is bounded by
  "active users who enabled push", which is inherently service-desk sized.

### Write path

Four Server Actions, each opening with `requireUser()`:

- `savePushSubscriptionAction`
- `removePushSubscriptionAction`
- `updateNotificationPrefsAction`
- `toggleWatchItemAction`

The subscription row is bound to the **session** user id. The client supplies only the
endpoint and its two keys — never a user id. Subscribe carries its own rate-limit scope
(`push-subscribe`) **inside the action**, not in the proxy: a 429 returned to a Server
Action POST cannot be rendered by `useActionState` and escalates to the error boundary.

### Trigger points

Existing actions call a `notify*` helper inside `after()`, matching how
`sendDecisionEmail` and the password-reset email already work, so response time is
unaffected by push delivery.

## Error handling

| Condition | Behaviour |
|---|---|
| `404` / `410` from the push service | Endpoint is dead → delete the `PushSubscription` row |
| `429` / `5xx` | Log, leave the row, no retry |
| Any send failure | Swallowed — a push failure must never fail the action that triggered it |
| VAPID env vars unset | `sendPush` is a logged no-op, so local dev and preview builds do not crash |

**The cron sweep catches its own errors.** `/api/cron/purge` runs five sweeps in one
`Promise.all`, where a single rejection discards all results and returns 500. The push
sweep must never be the thing that takes the purge job down.

## Configuration

Three new environment variables, generated once with
`npx web-push generate-vapid-keys`:

- `VAPID_PRIVATE_KEY` — server only, never `NEXT_PUBLIC_`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT` — a `mailto:` URL

No paid service is involved at any point.

## Testing

- `categories.test.ts` — pure defaults and the category→capability map.
- `push.service.test.ts` — endpoint pruning on 410, capability + preference filtering,
  batch collapsing (ten flagged items → one notification).
- `proxy.test.ts` — `/sw.js` excluded from the matcher.
- jsdom component tests for the `/account` settings panel and the watch toggle.

**None of that is evidence the feature works.** iOS only offers the permission prompt
inside the installed home-screen app, so the real verification is the cloudflared tunnel
→ iPhone → install → subscribe → trigger route.

## Documentation to update in the same commit

- `CHANGELOG.md` — user-facing feature, under today's date, with a **Notes** subsection
  for the three env vars and the two new tables.
- `docs/SECURITY.md` — new stored endpoint, new secrets, the PII-minimal payload rule,
  and the rate-limit scope. Note as mitigation that Web Push payloads are end-to-end
  encrypted with the subscription's own keys, so Apple and Google cannot read them.
- `src/app/manifest.ts` — the "deliberately NOT a PWA / no service worker" comment
  becomes untrue as written.
- `CLAUDE.md` §4c — the "There is deliberately NO service worker and no offline cache"
  bullet narrows to "no `fetch` handler, no offline cache". Leaving it stale would
  mislead the next reader into reverting this work.
- Migrate-before-push: the two new tables and four columns must be applied to Supabase
  before the merge deploys.
