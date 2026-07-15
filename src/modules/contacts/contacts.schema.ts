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

const rank = z
  .string()
  .trim()
  .max(20)
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
