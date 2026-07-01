import { z } from "zod";

export const newItemSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  serialNumber: z.string().trim().min(1, "Serial number is required"),
  assetTag: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined).optional(),
  homeLocation: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined).optional(),
  notes: z.string().trim().optional().or(z.literal("")).transform((v) => v || undefined).optional(),
});

export type NewItemInput = z.infer<typeof newItemSchema>;
