import { z } from "zod";

// Optional free-text rank; blank/whitespace collapses to undefined (→ NULL).
const rank = z
  .string()
  .trim()
  .max(20)
  .transform((v) => v || undefined)
  .optional();

const email = z
  .string()
  .trim()
  .email()
  .transform((v) => v.toLowerCase());

const optionalText = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);

export const newUserSchema = z.object({
  rank,
  name: z.string().trim().min(1),
  email,
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
  unit: optionalText,
  contactNumber: optionalText,
});
export type NewUserInput = z.infer<typeof newUserSchema>;
