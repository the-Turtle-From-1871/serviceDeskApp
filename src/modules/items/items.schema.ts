import { z } from "zod";

const optional = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);

export const newItemSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  serialNumber: z.string().trim().min(1, "Serial number is required"),
  homeUnit: optional,
  notes: optional,
});

export type NewItemInput = z.infer<typeof newItemSchema>;
