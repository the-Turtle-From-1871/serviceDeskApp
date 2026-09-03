import { STALE_SYNC_DAYS } from "./stale-window";

/**
 * Pure logic for the dormant-device notification: who gets told, about what,
 * and what the message says.
 *
 * No Prisma, no email transport, no `server-only` — so the grouping rule can be
 * exercised directly, which matters more than usual here: getting it wrong
 * sends real mail to real people and cannot be undone.
 */

export type NotifiableItem = {
  id: string;
  deviceName: string | null;
  make: string;
  model: string;
  serialNumber: string;
  /** Raw MDM text. NOT validated as an address anywhere — see `groupForNotify`. */
  lastLogonUserPrincipalName: string | null;
};

export type NotifyGroup = { email: string; devices: NotifiableItem[] };

export type NotifyPlan = {
  /** One entry per PERSON, each listing every one of their dormant devices. */
  groups: NotifyGroup[];
  /** Selected devices nobody can be told about. Reported, never silently dropped. */
  skipped: { item: NotifiableItem; reason: string }[];
};

/**
 * An address we are willing to send to.
 *
 * Deliberately a shape check, not validation: `lastLogonUserPrincipalName` is
 * raw MDM text that the importer copies verbatim, and the sibling field
 * `currentUserEmail` is known to hold values like "SGT Smith". Requiring an `@`
 * with something either side of it, and no spaces, is enough to keep obvious
 * non-addresses out of a send. It cannot tell a real mailbox from a plausible
 * one — a wrong-but-well-formed address bounces into the sending mailbox rather
 * than failing here.
 */
function looksSendable(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Group dormant devices by the person who last signed in to them.
 *
 * ONE EMAIL PER PERSON, not per device. That is the whole point of this
 * function: in the live fleet a single user holds 23 dormant devices, and
 * mailing them 23 times would be indistinguishable from a mail loop.
 *
 * Grouping is case-insensitive because MDM is inconsistent about the casing of
 * a UPN; the address actually used is the first spelling seen, so the recipient
 * sees their own address as their directory renders it.
 *
 * Order is deterministic — groups by first appearance, devices in the order
 * given — so a preview shown to an operator matches the send that follows it.
 */
export function groupForNotify(items: NotifiableItem[]): NotifyPlan {
  const byKey = new Map<string, NotifyGroup>();
  const skipped: NotifyPlan["skipped"] = [];

  for (const item of items) {
    const raw = (item.lastLogonUserPrincipalName ?? "").trim();
    if (!raw) {
      skipped.push({ item, reason: "no last-logon user recorded" });
      continue;
    }
    if (!looksSendable(raw)) {
      skipped.push({ item, reason: `last-logon user is not an address (${raw})` });
      continue;
    }
    const key = raw.toLowerCase();
    const group = byKey.get(key);
    if (group) group.devices.push(item);
    else byKey.set(key, { email: raw, devices: [item] });
  }

  return { groups: [...byKey.values()], skipped };
}

/** How a device is named to its holder: the MDM name if it has a real one,
 *  otherwise make + model. The serial is always shown — it is the only thing
 *  printed on the device itself, so it is what lets someone find it. */
function describe(item: NotifiableItem): string {
  const name = (item.deviceName ?? "").trim();
  const label = name && !name.startsWith("BE-") ? name : `${item.make} ${item.model}`;
  return `  - ${label} (SN ${item.serialNumber})`;
}

export const NOTIFY_SUBJECT = "Action needed: your DCSIM device has not checked in";

/**
 * The message body.
 *
 * Carries NO LINK. `APP_URL` is a local dev server, so any URL here would
 * resolve to the recipient's own machine — and a dead link in a message asking
 * someone to take an action is worse than no link at all.
 */
export function notifyBody(group: NotifyGroup): string {
  const one = group.devices.length === 1;
  // One sentence per line, unwrapped. A text/plain body is rendered with its
  // newlines intact, so hard-wrapping mid-sentence here shows up as ragged
  // breaks in the recipient's client — let the client wrap to its own width.
  return [
    `The following ${one ? "device has" : "devices have"} not checked in with DCSIM for more than ${STALE_SYNC_DAYS} days:`,
    ``,
    group.devices.map(describe).join("\n"),
    ``,
    `This usually means ${one ? "it has" : "they have"} been powered off or kept off the network. Please connect ${one ? "it" : "them"} to the network so ${one ? "it" : "they"} can receive updates and report in.`,
    ``,
    `No reply is needed — this message is sent automatically from the DCSIM Service Desk equipment records.`,
  ].join("\n");
}

/** The desk's own copy: what the run did, in one message rather than one per
 *  person. Sent to the record addresses INSTEAD of CC-ing every notification,
 *  which on the live fleet would put 113 messages into a shared mailbox. */
export function summaryBody(plan: NotifyPlan, sent: number, failed: { email: string; reason: string }[]): string {
  const devices = plan.groups.reduce((n, g) => n + g.devices.length, 0);
  return [
    `Dormant-device notifications sent.`,
    ``,
    `  People notified : ${sent}`,
    `  Devices covered : ${devices}`,
    `  Devices skipped : ${plan.skipped.length}`,
    ``,
    ...(failed.length
      ? [`Failed to send (${failed.length}):`, ...failed.map((f) => `  - ${f.email}: ${f.reason}`), ``]
      : []),
    ...(plan.skipped.length
      ? [
          `Skipped devices — nobody to notify:`,
          ...plan.skipped.slice(0, 50).map((s) => `  - ${s.item.serialNumber}: ${s.reason}`),
          ...(plan.skipped.length > 50 ? [`  …and ${plan.skipped.length - 50} more`] : []),
        ]
      : []),
  ].join("\n");
}
