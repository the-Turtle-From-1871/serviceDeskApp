"use server";
import { requireUser } from "@/lib/authz";
import { searchContacts } from "@/modules/contacts/contacts.service";
import type { ContactOption } from "@/modules/contacts/contact-match";

// Contact-book type-ahead for the receipt builder. Authed (the builder requires a
// session) and capped, so the full book — outside people's names, emails, phone
// numbers — never ships to the client. Returns [] on error rather than throwing,
// so a transient failure just yields no suggestions, never a broken form.
export async function searchContactsAction(query: string): Promise<ContactOption[]> {
  await requireUser();
  try {
    return await searchContacts(query);
  } catch (e) {
    console.error("[searchContactsAction] failed:", e);
    return [];
  }
}
