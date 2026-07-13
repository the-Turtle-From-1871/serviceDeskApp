import { z } from "zod";

// Optional free-text rank; blank/whitespace collapses to undefined (→ NULL).
const rank = z
  .string()
  .trim()
  .max(20)
  .transform((v) => v || undefined)
  .optional();

export const emailField = z
  .string()
  .trim()
  .email()
  .transform((v) => v.toLowerCase());

export const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters");

const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

export const newUserSchema = z.object({
  rank,
  name: z.string().trim().min(1),
  email: emailField,
  password: passwordField,
  role: z.enum(["ADMIN", "USER"]).default("USER"),
  unit: optionalText,
  contactNumber: optionalText,
});
export type NewUserInput = z.infer<typeof newUserSchema>;

// Public self-registration: same fields as admin create, minus role (always USER).
export const registerSchema = newUserSchema.omit({ role: true });
export type RegisterInput = z.infer<typeof registerSchema>;
