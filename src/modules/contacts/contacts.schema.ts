import { z } from "zod";
import { emailField } from "@/modules/users/users.schema";

// emailField is imported, not redefined: it is the canonical trim+lowercase
// transform, and it MUST agree with the citext column or the unique constraint
// and our lookups would disagree about identity.

// Blank/whitespace collapses to undefined (→ NULL). Mirrors users.schema.
const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

// Exported so `upsertContactFromParty` can DROP an over-long rank before it
// reaches this schema rather than losing the whole contact to a parse failure.
// It must be the one definition: a local copy that drifted below this cap would
// let an over-long value past the caller's check and straight into a refusal
// here — exactly the outcome the drop exists to prevent.
export const RANK_MAX_LENGTH = 20;

const rank = z
  .string()
  .trim()
  .max(RANK_MAX_LENGTH)
  .transform((v) => v || undefined)
  .optional();

export const newContactSchema = z.object({
  rank,
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  email: emailField,
  unit: optionalText,
  contactNumber: optionalText,
});
export type NewContactInput = z.infer<typeof newContactSchema>;

export const updateContactSchema = newContactSchema.extend({
  id: z.string().min(1),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
