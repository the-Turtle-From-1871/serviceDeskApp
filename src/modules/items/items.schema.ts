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
  currentUserEmail: clearable,
  currentPosition: clearable,
});

export type ItemDetailsInput = z.infer<typeof itemDetailsSchema>;

// Fields a non-admin USER may edit from the item detail card: only who currently
// holds the device and where it is. deviceName/homeUnit/notes stay ADMIN-only
// (itemDetailsSchema). Because z.object() strips unknown keys, parsing a USER's
// submission through this schema discards any deviceName/homeUnit a crafted POST
// tries to smuggle in — the server, not the UI, is the authority.
export const userItemDetailsSchema = z.object({
  currentUserEmail: clearable,
  currentPosition: clearable,
});

export type UserItemDetailsInput = z.infer<typeof userItemDetailsSchema>;
