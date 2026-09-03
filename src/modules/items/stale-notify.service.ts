import "server-only"; // sends real mail to real people — never bundle to the client
import prisma from "@/lib/prisma";
import { getEmailSender, type EmailSender } from "@/lib/email";
import { receiptCcEmails } from "@/lib/email-recipients";
import { MAX_BULK_ITEMS } from "./items.schema";
import { ItemError } from "./items.errors";
import {
  groupForNotify,
  notifyBody,
  summaryBody,
  NOTIFY_SUBJECT,
  type NotifiableItem,
  type NotifyPlan,
} from "./stale-notify";

/**
 * Tell the last person who signed in to a dormant device that it has not
 * checked in.
 *
 * The grouping and the wording are pure and live in `stale-notify.ts`; this
 * file is the part that reaches the database and the mail transport.
 *
 * TWO THINGS MAKE THIS DIFFERENT FROM EVERY OTHER BULK ACTION HERE, and both
 * are why it is a two-step preview-then-send rather than one button:
 *
 *  - It is the only bulk action whose effect leaves the building. An audit or a
 *    category change is a row this app owns and can correct; a sent email is
 *    gone. On the live fleet one run reaches ~113 people at army.mil.
 *  - The count an operator selects is NOT the count that gets mailed. Devices
 *    with no last-logon user are unreachable, and a person holding 23 dormant
 *    devices is ONE message. 242 selected can mean 113 sent — a number nobody
 *    would predict from the selection, so it is shown before anything is sent.
 */

export type NotifyPreview = {
  /** People who would be emailed, and how many devices each would hear about. */
  recipients: { email: string; deviceCount: number }[];
  deviceCount: number;
  /** Selected devices nobody can be told about, with the reason for each. */
  skipped: { serialNumber: string; reason: string }[];
  /** Retired devices dropped from the selection before anything else ran. */
  retiredSkipped: number;
};

export type NotifyResult = NotifyPreview & {
  sent: number;
  failed: { email: string; reason: string }[];
};

/** The columns the notification needs, and no others — never the signature
 *  blobs or holder PII that a list query would drag along. */
async function loadNotifiable(itemIds: string[]): Promise<{ items: NotifiableItem[]; retiredSkipped: number }> {
  if (itemIds.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");
  const rows = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    select: {
      id: true,
      deviceName: true,
      make: true,
      model: true,
      serialNumber: true,
      lastLogonUserPrincipalName: true,
      status: true,
    },
  });
  // Retired kit has left the fleet, so "please reconnect it to the network" is
  // a wrong instruction. EXCLUDED AND REPORTED, never a refusal of the batch —
  // the same rule every other bulk item write here follows.
  const active = rows.filter((r) => r.status !== "RETIRED");
  return {
    // `status` is selected for the retired filter above but is not part of the
    // notifiable shape, so it is stripped here rather than carried further.
    items: active.map((r) => ({
      id: r.id, deviceName: r.deviceName, make: r.make, model: r.model,
      serialNumber: r.serialNumber, lastLogonUserPrincipalName: r.lastLogonUserPrincipalName,
    })),
    retiredSkipped: rows.length - active.length,
  };
}

function toPreview(plan: NotifyPlan, retiredSkipped: number): NotifyPreview {
  return {
    recipients: plan.groups.map((g) => ({ email: g.email, deviceCount: g.devices.length })),
    deviceCount: plan.groups.reduce((n, g) => n + g.devices.length, 0),
    skipped: plan.skipped.map((s) => ({ serialNumber: s.item.serialNumber, reason: s.reason })),
    retiredSkipped,
  };
}

/** What a send WOULD do. Reads only — no mail leaves. */
export async function previewStaleNotifications(itemIds: string[]): Promise<NotifyPreview> {
  const { items, retiredSkipped } = await loadNotifiable(itemIds);
  return toPreview(groupForNotify(items), retiredSkipped);
}

/**
 * Send the notifications.
 *
 * Sends are SEQUENTIAL, not `Promise.all`. Firing 113 concurrent requests at
 * Gmail is how an account earns a rate-limit block, and this has no deadline —
 * a slower loop that finishes is worth more than a fast one that gets throttled
 * halfway and leaves nobody able to say who was told.
 *
 * ONE FAILURE NEVER STOPS THE RUN. A bad address is expected here rather than
 * exceptional: `lastLogonUserPrincipalName` is raw MDM text and nothing has
 * ever validated it as a mailbox. Each failure is collected and reported, so
 * the operator learns which addresses to fix rather than which point the run
 * died at.
 */
export async function sendStaleNotifications(
  itemIds: string[],
  deps: { sender?: EmailSender } = {},
): Promise<NotifyResult> {
  const sender = deps.sender ?? getEmailSender();
  const { items, retiredSkipped } = await loadNotifiable(itemIds);
  const plan = groupForNotify(items);

  const failed: { email: string; reason: string }[] = [];
  let sent = 0;
  for (const group of plan.groups) {
    try {
      // NO CC. Every other custody email copies the record addresses, and here
      // that would put one message per person into a shared mailbox — 113 of
      // them on the live fleet, burying everything else in it. The desk gets
      // ONE summary below instead.
      await sender.send({ to: group.email, subject: NOTIFY_SUBJECT, text: notifyBody(group) });
      sent++;
    } catch (e) {
      failed.push({ email: group.email, reason: e instanceof Error ? e.message : "send failed" });
    }
  }

  // The desk's record that the run happened, and its only view of what failed.
  // Best-effort and last: a summary that could not be sent must not make a
  // completed run look failed, and the notifications have already gone.
  const record = receiptCcEmails();
  if (record.length > 0) {
    try {
      await sender.send({
        to: record[0],
        cc: record.slice(1).length ? record.slice(1) : undefined,
        subject: `Dormant-device notifications sent (${sent})`,
        text: summaryBody(plan, sent, failed),
      });
    } catch (e) {
      console.error("[stale-notify] summary could not be sent:", e);
    }
  }

  return { ...toPreview(plan, retiredSkipped), sent, failed };
}
