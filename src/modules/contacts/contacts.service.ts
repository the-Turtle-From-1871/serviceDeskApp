import type { Contact } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  newContactSchema,
  updateContactSchema,
  type NewContactInput,
  type UpdateContactInput,
} from "./contacts.schema";
import type { ContactOption } from "./contact-match";
import { ContactError } from "./contacts.errors";

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

export async function deleteContact(id: string): Promise<void> {
  // deleteMany (not delete) so a missing id yields a count of 0 rather than a
  // raw Prisma throw, letting the action distinguish already-gone from a real
  // failure. (Unlike signatures.service.deleteSignature, this isn't about
  // ownership scoping — the contact book is shared org-wide, so there's no
  // `userId` to scope on.)
  const { count } = await prisma.contact.deleteMany({ where: { id } });
  if (count === 0) throw new ContactError("NOT_FOUND");
}
