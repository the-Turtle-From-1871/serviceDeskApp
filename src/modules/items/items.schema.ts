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

// The fields any authenticated user may edit from the item detail card.
//
// NOTE: deliberately does NOT use the `optional` helper above. That helper maps
// "" -> undefined, and `diffItemFields` treats an undefined value as "not
// submitted" — so an emptied input would silently fail to clear the stored
// value. Keeping the blank string lets the diff record a clear-to-null.
const clearable = z.string().trim();

export const itemDetailsSchema = z.object({
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: clearable,
  currentUser: clearable,
  currentPosition: clearable,
});

export type ItemDetailsInput = z.infer<typeof itemDetailsSchema>;
