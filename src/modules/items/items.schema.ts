import { z } from "zod";

const optional = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

export const newItemSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  serialNumber: z.string().trim().min(1, "Serial number is required"),
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: optional,
  notes: optional,
});

export type NewItemInput = z.infer<typeof newItemSchema>;
