import prisma from "@/lib/prisma";
import { upsertContactFromParty, type ContactPartyInput } from "./contacts.service";
import { parsePartyName } from "./party-name";

// One-off backfill: seed the shared contact book from the parties already
// recorded on existing hand receipts. Without it the book only fills going
// forward, so everyone on the receipts filed before that feature shipped stays
// missing from the builder's type-ahead until they happen to be issued to again.
//
// Deliberately NOT wired to a button. It is an operator-run script
// (`npm run backfill:contacts`) rather than an admin action, because it is a
// one-time job and an admin surface would be a permanent privileged write path
// into the book that has to be designed, gated and written up in
// docs/SECURITY.md. Running it twice is harmless (see idempotence below), so it
// needs no run-once bookkeeping.
//
// Reuses `upsertContactFromParty` rather than reimplementing the save. That is
// the whole point: the DCSIM skip, the create-only name, the blank-rank rule and
// the email match key are one implementation, so the backfill and the live path
// cannot drift the way two copies of a rule always eventually do.

const SCAN_BATCH = 500;
const EXISTS_CHUNK = 500;

export type BackfillResult = {
  receiptsScanned: number;
  /** Non-DCSIM party slots seen, before de-duplication. */
  partiesSeen: number;
  /** Distinct people (by email) the scan resolved to. */
  distinctPeople: number;
  created: number;
  updated: number;
  /** Resolved people whose name could not be split into two columns. */
  skipped: number;
};

type Candidate = { party: ContactPartyInput; createdById: string | null };

/** The party columns as stored on a receipt, for one side. */
function sideOf(
  t: {
    senderIsDcsim: boolean; senderName: string; senderRank: string | null; senderUnit: string | null; senderContact: string | null; senderEmail: string | null;
    receiverIsDcsim: boolean; receiverName: string; receiverRank: string | null; receiverUnit: string | null; receiverContact: string | null; receiverEmail: string | null;
  },
  role: "sender" | "receiver",
): ContactPartyInput {
  return role === "sender"
    ? { isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank ?? undefined, unit: t.senderUnit ?? undefined, contact: t.senderContact ?? undefined, email: t.senderEmail ?? undefined }
    : { isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank ?? undefined, unit: t.receiverUnit ?? undefined, contact: t.receiverContact ?? undefined, email: t.receiverEmail ?? undefined };
}

/** Which stored emails already have a contact. Chunked so the IN list stays bounded. */
async function existingEmails(emails: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < emails.length; i += EXISTS_CHUNK) {
    const rows = await prisma.contact.findMany({
      where: { email: { in: emails.slice(i, i + EXISTS_CHUNK) } },
      select: { email: true },
    });
    // Emails come back citext-normalized; the map below is keyed lowercase.
    for (const r of rows) found.add(r.email.toLowerCase());
  }
  return found;
}

/**
 * Files every non-DCSIM party on every existing receipt into the contact book.
 *
 * **Newest receipt wins.** Receipts are scanned oldest-first and de-duplicated
 * by email into ONE candidate per person, so a contact is written once with
 * their most recent unit and phone number — not once per receipt, oldest last.
 * That also means someone on forty receipts costs one write, not forty.
 *
 * **Idempotent.** A second run resolves the same candidates and re-writes the
 * same values; nothing is duplicated, because email is the citext-unique key.
 *
 * Note the reachable history is bounded by retention, not by this function:
 * closed receipts are purged 90 days after closing, so parties who only ever
 * appeared on long-closed receipts are already gone from the database and
 * cannot be recovered here.
 */
export async function backfillContactsFromReceipts(
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  // Keyed by lowercased email. Scanning ascending means a later (newer) receipt
  // overwrites an earlier one, so the survivor is the most recent sighting.
  const newest = new Map<string, Candidate>();
  let receiptsScanned = 0;
  let partiesSeen = 0;

  // Cursor pagination, not `skip` — skip re-walks the offset every batch, and
  // this table is the one that grows fastest in the app.
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.transfer.findMany({
      take: SCAN_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, createdByUserId: true,
        senderIsDcsim: true, senderName: true, senderRank: true, senderUnit: true, senderContact: true, senderEmail: true,
        receiverIsDcsim: true, receiverName: true, receiverRank: true, receiverUnit: true, receiverContact: true, receiverEmail: true,
      },
    });
    if (batch.length === 0) break;
    receiptsScanned += batch.length;

    for (const t of batch) {
      for (const role of ["sender", "receiver"] as const) {
        const party = sideOf(t, role);
        if (party.isDcsim) continue;
        const email = party.email?.trim().toLowerCase();
        if (!email) continue;
        partiesSeen++;
        newest.set(email, { party, createdById: t.createdByUserId });
      }
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < SCAN_BATCH) break;
  }

  const emails = [...newest.keys()];
  const already = await existingEmails(emails);
  const result: BackfillResult = {
    receiptsScanned, partiesSeen, distinctPeople: emails.length,
    created: 0, updated: 0, skipped: 0,
  };

  for (const [email, { party, createdById }] of newest) {
    // On a dry run, decide the outcome without writing. `parsePartyName` is the
    // same gate the service applies, so the preview cannot disagree with the
    // real run about which people get skipped.
    if (dryRun) {
      if (!parsePartyName(party.name)) result.skipped++;
      else if (already.has(email)) result.updated++;
      else result.created++;
      continue;
    }
    // One write per distinct person, once, in a one-off script — not the
    // request-path N+1 the data-fetching rule bans. The scan above is batched.
    const saved = await upsertContactFromParty(party, createdById, { refreshExisting: true });
    if (!saved) result.skipped++;
    else if (already.has(email)) result.updated++;
    else result.created++;
  }

  return result;
}
