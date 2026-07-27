import { z } from "zod";

export const MAX_CATEGORY_NAME = 60;

/** Canonical stored form for a device category: trimmed, internal whitespace
 *  collapsed. Case is preserved for display; uniqueness is case-insensitive
 *  via the citext column.
 *
 *  Lives HERE (a pure module) rather than in categories.service.ts, which is
 *  `server-only`: every write path — CSV import, the admin edit form, and the
 *  vocabulary itself — must apply the SAME normalization, or an item's stored
 *  string and its category row drift apart and the in-use count silently
 *  misses (which would let an admin delete a category still in use). */
export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Category cell: normalized, with blank collapsing to undefined ("not
 *  provided" → leave untouched), and over-long values dropped rather than
 *  truncated. */
const categoryOptional = z
  .string()
  .trim()
  .transform((v) => {
    const name = normalizeCategoryName(v);
    return name && name.length <= MAX_CATEGORY_NAME ? name : undefined;
  })
  .optional();

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

// Row shape for the CSV importer. Only serialNumber is hard-required here — the
// make/model-required-for-NEW-items rule lives in planImport, which alone knows
// whether the serial already exists. Reuses the `optional` helper so blank/absent
// cells become undefined ("not provided" → leave untouched on update).
export const importRowSchema = z.object({
  serialNumber: z.string().trim().min(1, "serial number is required"),
  make: optional,
  model: optional,
  deviceName: optional,
  homeUnit: optional,
  deviceUIC: optional,
  deviceCategory: categoryOptional,
  notes: optional,
  assignedUser: optional,
  lastLogonUserPrincipalName: optional,
  lastLogonDate: optional,
  enrollmentDate: optional,
  compliance: optional,
});

export type ImportRowInput = z.infer<typeof importRowSchema>;

// The fields any authenticated user may edit from the item detail card.
//
// NOTE: deliberately does NOT use the `optional` helper above. That helper maps
// "" -> undefined, and `diffItemFields` treats an undefined value as "not
// submitted" — so an emptied input would silently fail to clear the stored
// value. Keeping the blank string lets the diff record a clear-to-null.
const clearable = z.string().trim();

/**
 * The admin item-edit form's field set.
 *
 * Deliberately NOT `newItemSchema.partial()`: that schema has no deviceUIC or
 * deviceCategory keys, and `z.object()` STRIPS unknown keys — so posting those
 * two fields parsed cleanly, dropped them, and the form reported "Saved" while
 * changing nothing. Any field the edit form renders must be declared here.
 *
 * Uses `clearable` (not `optional`) for the two nullable text fields so
 * emptying the input records a clear-to-null instead of reading as "not
 * submitted" — see the note on `clearable` above.
 */
export const adminItemEditSchema = newItemSchema.partial().extend({
  deviceUIC: z.string().trim().optional(),
  deviceCategory: categoryOptional,
});

export type AdminItemEditInput = z.infer<typeof adminItemEditSchema>;

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
