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

export const newUserSchema = z.object({
  rank,
  name: z.string().trim().min(1),
  email,
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});
export type NewUserInput = z.infer<typeof newUserSchema>;

// Public self-registration: identical to admin create, but the role is always USER.
export const registerSchema = newUserSchema.omit({ role: true });
export type RegisterInput = z.infer<typeof registerSchema>;
