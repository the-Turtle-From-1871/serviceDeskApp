import { z } from "zod";
export const newUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});
export type NewUserInput = z.infer<typeof newUserSchema>;
