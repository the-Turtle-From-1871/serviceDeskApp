import type { Contact } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  newContactSchema,
  updateContactSchema,
  RANK_MAX_LENGTH,
  type NewContactInput,
  type UpdateContactInput,
} from "./contacts.schema";
import type { ContactOption } from "./contact-match";
import { ContactError } from "./contacts.errors";
import { parsePartyName } from "./party-name";

// The book is shared org-wide: reads are unscoped by design. Write authorization
// is enforced at the action layer (requireAdmin), not here.

export function listContacts(): Promise<Contact[]> {
  return prisma.contact.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

const CONTACT_SEARCH_LIMIT = 8;

// Server-side type-ahead for the receipt builder, so the whole book (PII) no
// longer ships to the client. Token-AND across name/email/unit — every
// whitespace-separated token must match some field — so "jane doe" and "doe jane"
// both hit, and a single token narrows as you type. Rank is deliberately excluded
// (low cardinality would bury the real match), mirroring the old client matcher.
export async function searchContacts(query: string): Promise<ContactOption[]> {
  const q = query.trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);
  return prisma.contact.findMany({
    where: {
      AND: tokens.map((t) => ({
        OR: [
          { firstName: { contains: t, mode: "insensitive" } },
          { lastName: { contains: t, mode: "insensitive" } },
          { email: { contains: t, mode: "insensitive" } },
          { unit: { contains: t, mode: "insensitive" } },
        ],
      })),
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: CONTACT_SEARCH_LIMIT,
    select: { id: true, rank: true, firstName: true, lastName: true, unit: true, contactNumber: true, email: true },
  });
}

// P2002 = unique violation on `email` — a contact already owns that inbox.
function asDuplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new ContactError("DUPLICATE_EMAIL");
  }
  throw e;
}

export async function createContact(input: NewContactInput, createdById: string): Promise<Contact> {
  const data = newContactSchema.parse(input);
  try {
    return await prisma.contact.create({ data: { ...data, createdById } });
  } catch (e) {
    asDuplicate(e);
  }
}

export async function updateContact(input: UpdateContactInput): Promise<Contact> {
  const { id, ...data } = updateContactSchema.parse(input);
  try {
    return await prisma.contact.update({
      where: { id },
      // The optionals are mapped `undefined` -> `null` explicitly. The schema
      // turns a blank field into `undefined`, and Prisma reads `undefined` as
      // "leave this column alone" — so without this, clearing a contact's unit
      // in the edit form would silently keep the old value.
      data: {
        ...data,
        rank: data.rank ?? null,
        unit: data.unit ?? null,
        contactNumber: data.contactNumber ?? null,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new ContactError("NOT_FOUND");
    }
    asDuplicate(e);
  }
}

// Structural, NOT an import of transfers.schema's PartyInput. The contact book
// is read by the receipt builder, so a type dependency back the other way would
// make the two modules mutually referential for no gain — and this shape is the
// contract, not that specific schema's inferred type.
export type ContactPartyInput = {
  isDcsim: boolean;
  name: string;
  rank?: string;
  unit?: string;
  contact?: string;
  email?: string;
};

/**
 * Files a hand-receipt party into the shared contact book, keyed on the
 * citext-unique email: existing entry refreshed, new one created. Returns
 * `null` when there is nothing valid to save.
 *
 * Called best-effort from `createReceiptAction` for every NON-DCSIM party on a
 * filed receipt — a DCSIM party is one of our own technicians, who has an
 * account and is not in the book at all (the same `!isDcsim` gate the
 * ContactCombobox uses to decide whether to offer the book in the first place).
 *
 * `refreshExisting: false` makes the call CREATE-ONLY: a person not yet in the
 * book is added, and one already there is returned untouched. Used for the
 * SENDER — see the caller in `createReceiptAction` for why that side's fields
 * are not evidence of anything current.
 *
 * NOTE this is the one write path into the book that is NOT admin-only:
 * `requireUser` gates receipt creation, so a standard USER filing a receipt
 * both creates and updates shared entries. That is a deliberate widening —
 * see docs/SECURITY.md §2.
 */
export async function upsertContactFromParty(
  party: ContactPartyInput,
  // Nullable for the BACKFILL only (`backfill.ts`): it attributes each row to the
  // technician who filed that receipt, and `Transfer.createdByUserId` is nullable
  // (ON DELETE SET NULL), so a receipt filed by a since-deleted account has no id
  // to credit. `Contact.createdBy` is nullable for the same reason — the shared
  // book must outlive the account that happened to add a row. The live path
  // always passes a real id from `requireUser()`.
  createdById: string | null,
  { refreshExisting = true }: { refreshExisting?: boolean } = {}
): Promise<Contact | null> {
  // Defence in depth: the caller already skips DCSIM parties, but this function
  // is the one that knows the book holds outside people only.
  if (party.isDcsim) return null;
  if (!party.email?.trim()) return null;

  const name = parsePartyName(party.name);
  if (!name) return null; // unsplittable — skip rather than misfile

  // An over-long rank is DROPPED rather than rejected — losing a stray rank is
  // better than losing the whole contact over it, mirroring the CSV importer,
  // which drops an over-long category while the hand forms reject one. The cap
  // is imported, never restated, so it cannot drift below the schema's and turn
  // the drop back into a refusal.
  const rank = party.rank?.trim() ?? "";
  // Routed through the SAME schema the admin form uses, so an auto-saved row and
  // a hand-typed one are normalized identically (trimmed, email lowercased,
  // blanks collapsed to undefined). safeParse, not parse: this is a best-effort
  // path, and "nothing worth saving" must be distinguishable from a DB failure.
  const parsed = newContactSchema.safeParse({
    rank: rank.length <= RANK_MAX_LENGTH ? rank : "",
    firstName: name.firstName,
    lastName: name.lastName,
    email: party.email,
    unit: party.unit ?? "",
    contactNumber: party.contact ?? "",
  });
  if (!parsed.success) {
    console.warn("[upsertContactFromParty] party did not make a valid contact:", parsed.error.issues[0]?.message);
    return null;
  }
  const data = parsed.data;

  // A non-DCSIM party always carries unit, contact and email (partySchema's
  // superRefine requires all three), so those refresh from the receipt. `rank`
  // is the one field that can legitimately arrive blank, and a blank one is far
  // more likely an omission on the form than a correction, so it is omitted
  // from the update entirely (Prisma reads `undefined` as "leave this column
  // alone") rather than nulling a rank someone already recorded.
  //
  // firstName/lastName are deliberately NOT here — the split is CREATE-ONLY,
  // like `createdById`. `parsePartyName` is lossy in one direction and the
  // builder's own autofill feeds it: ContactCombobox's onPick writes
  // `"${firstName} ${lastName}"` back into the single name field, so a contact
  // curated as "Mary Jo" / "Smith" comes back as "Mary Jo Smith" and re-parses
  // to "Mary" / "Jo Smith". Picking that contact and filing the receipt — with
  // nobody typing anything — would silently rewrite a correct row. Typing the
  // full name by hand does the same, so guarding onPick alone is not enough.
  // The name a contact was first filed under therefore changes only by a
  // deliberate admin edit on /admin/users.
  const update = refreshExisting
    ? {
        unit: data.unit ?? null,
        contactNumber: data.contactNumber ?? null,
        ...(data.rank ? { rank: data.rank } : {}),
      }
    : {}; // create-only: an existing row is returned untouched

  try {
    return await prisma.contact.upsert({
      where: { email: data.email },
      // `createdById` is on CREATE only. Re-filing a receipt for someone already
      // in the book must not reassign authorship of an entry another account
      // curated.
      create: {
        ...data,
        rank: data.rank ?? null,
        unit: data.unit ?? null,
        contactNumber: data.contactNumber ?? null,
        createdById,
      },
      update,
    });
  } catch (e) {
    // Two receipts filed concurrently for the same new email: both upserts see
    // no row, both insert, one loses on the unique constraint. The loser's
    // intent is still an update, so apply it rather than surfacing a failure.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return prisma.contact.update({ where: { email: data.email }, data: update });
    }
    throw e;
  }
}

export async function deleteContact(id: string): Promise<void> {
  // deleteMany (not delete) so a missing id yields a count of 0 rather than a
  // raw Prisma throw, letting the action distinguish already-gone from a real
  // failure. (Unlike signatures.service.deleteSignature, this isn't about
  // ownership scoping — the contact book is shared org-wide, so there's no
  // `userId` to scope on.)
  const { count } = await prisma.contact.deleteMany({ where: { id } });
  if (count === 0) throw new ContactError("NOT_FOUND");
}
