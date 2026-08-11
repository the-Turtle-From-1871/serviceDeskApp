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

/** Category cell for the CSV IMPORT: normalized, with blank collapsing to
 *  undefined ("not provided" → leave untouched), and over-long values dropped
 *  rather than truncated. An import must never fail on one bad cell.
 *
 *  NOT for the edit forms — see `categoryClearable` below, which keeps a blank
 *  so emptying the input clears the stored category. */
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

/**
 * An item's IDENTITY — what the device physically is, and the serial a signed
 * hand receipt names.
 *
 * All three are `.min(1)` required because they back NOT NULL columns on Item
 * (see the note at the top of item-diff.ts): a blank would try to null out a
 * NOT NULL column and fail at the DB.
 *
 * Shared by `newItemSchema` (creation) and `itemIdentitySchema` (the admin
 * edit page's separate identity form) so the two can never disagree about what
 * a valid make/model/serial is.
 */
const identityItemFields = {
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  // Bounded because the create form's serial can be PREFILLED FROM A URL
  // (?serialNumber=…, see the create-from-search flow). Production's longest
  // real serial is 14 characters, so 64 is generous headroom that cannot
  // reject a genuine device. Shared with itemIdentitySchema, so it bounds the
  // admin identity-edit form too.
  serialNumber: z.string().trim().min(1, "Serial number is required")
    .max(64, "Serial numbers are limited to 64 characters"),
} as const;

/** Category cell for the CREATE form. Blank -> undefined like `categoryOptional`
 *  (there is no prior value to clear on a row that does not exist yet, and
 *  writing "" would put an empty string into an indexed column that every
 *  filter and count treats as a value). But over-long names are REJECTED with a
 *  message like `categoryClearable`, not silently dropped: a form that says
 *  "Created" while discarding what was typed is the exact bug the note on
 *  `categoryClearable` warns about.
 *
 *  The trailing `.optional()` is load-bearing, not decoration. `createItem`
 *  re-parses its input through `newItemSchema` as defense at the service
 *  boundary, so the schema must accept its OWN output — and a blank category's
 *  output is `undefined`. Without it every create with no category fails on the
 *  second parse. `categoryOptional` and the `optional` helper end the same way
 *  for the same reason.
 *
 *  Spells out `z.string().trim()` rather than reusing the `clearable` helper
 *  below, because that helper is declared after `newItemSchema` and a const
 *  cannot be used before its declaration. */
const categoryNew = z
  .string()
  .trim()
  .transform((v) => normalizeCategoryName(v))
  .refine(
    (v) => v.length <= MAX_CATEGORY_NAME,
    `Category names are limited to ${MAX_CATEGORY_NAME} characters.`,
  )
  .transform((v) => v || undefined)
  .optional();

export const newItemSchema = z.object({
  ...identityItemFields,
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: optional,
  deviceUIC: optional,
  deviceCategory: categoryNew,
  storageLocation: optional,
  notes: optional,
});

export type NewItemInput = z.infer<typeof newItemSchema>;

/**
 * Creating an item from a SCAN. Identical to newItemSchema except that
 * `deviceName` is optional: a device scanned off a shelf may have no known
 * hostname, and requiring one blocks the create at the moment it is most
 * useful.
 *
 * Built with .extend() and NEVER restated — a second field list is a second
 * answer to "what is an item", and the two would drift. Same pattern as
 * registerSchema (newUserSchema minus role).
 *
 * KNOWN CONSEQUENCE: detectHomeUnit reads the device name, so items created
 * this way carry NO home unit until someone edits them or an import fills it
 * in. The create form says so.
 */
export const scannedItemSchema = newItemSchema.extend({ deviceName: optional });

export type ScannedItemInput = z.infer<typeof scannedItemSchema>;

/**
 * The admin edit page's IDENTITY-CORRECTION form (`updateItemIdentityAction`).
 *
 * Deliberately its OWN schema, and deliberately NOT merged into
 * `editableItemFields` below. Correcting a make/model/serial is a different act
 * from editing who holds a device: the serial is the identity existing signed
 * hand receipts refer to, so changing one rewrites what those receipts appear
 * to describe. Keeping it a separate schema + separate Server Action keeps the
 * eight-field editable set exactly as narrow as it is, and keeps the two
 * shared edit surfaces (item card + admin page) free of these fields — only the
 * admin edit page renders this one.
 *
 * `serialNumber` is `@unique @db.Citext`, so a value that already exists in ANY
 * casing raises a Prisma P2002; the action maps that to a specific message.
 */
export const itemIdentitySchema = z.object(identityItemFields);

export type ItemIdentityInput = z.infer<typeof itemIdentitySchema>;

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
  storageLocation: optional,
  notes: optional,
  assignedUser: optional,
  lastLogonUserPrincipalName: optional,
  lastLogonDate: optional,
  enrollmentDate: optional,
  compliance: optional,
  lastSyncDateTime: optional,
});

export type ImportRowInput = z.infer<typeof importRowSchema>;

// The fields any authenticated user may edit from the item detail card.
//
// NOTE: deliberately does NOT use the `optional` helper above. That helper maps
// "" -> undefined, and `diffItemFields` treats an undefined value as "not
// submitted" — so an emptied input would silently fail to clear the stored
// value. Keeping the blank string lets the diff record a clear-to-null.
const clearable = z.string().trim();

/** Category cell for the EDIT FORMS. Same canonical normalization as
 *  `categoryOptional`, but built on `clearable`, not `.optional()`: a blank
 *  input stays "" so emptying the category CLEARS it, instead of reading as
 *  "not submitted" and silently no-opping. Over-long values are REJECTED with
 *  a message rather than dropped — a form that reported "Saved" while quietly
 *  discarding what was typed is exactly the bug the note above warns about. */
const categoryClearable = clearable
  .transform((v) => normalizeCategoryName(v))
  .refine(
    (v) => v.length <= MAX_CATEGORY_NAME,
    `Category names are limited to ${MAX_CATEGORY_NAME} characters.`,
  );

/**
 * THE editable field set for an item — the eight fields both edit surfaces
 * expose, and the single definition they share so the two can never drift.
 *
 * Consumers: `adminItemEditSchema` (the /admin/items/[id]/edit page) and
 * `itemDetailsSchema` (the ADMIN branch of the item detail card).
 *
 * `make`, `model` and `serialNumber` are deliberately ABSENT: they are an
 * item's identity, and correcting one is a separate, deliberate act with its
 * own schema (`itemIdentitySchema`), its own action and its own form on the
 * ADMIN edit page only. Keeping them out of here is what stops the item detail
 * card — and a USER-facing surface — from ever rewriting the serial a receipt
 * was signed against.
 *
 * Declared explicitly rather than derived from `newItemSchema.partial()`,
 * because `z.object()` STRIPS unknown keys — a field the form renders but the
 * schema does not declare parses cleanly, gets dropped, and the form reports
 * "Saved" while changing nothing. Any field an edit form renders MUST be
 * declared here.
 *
 * Every nullable field uses `clearable` (not `optional`) so emptying its input
 * records a clear-to-null — see the note on `clearable` above. `deviceName`
 * stays required: it backs a NOT NULL column (see item-diff.ts).
 */
const editableItemFields = {
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: clearable,
  deviceUIC: clearable,
  currentUserEmail: clearable,
  currentPosition: clearable,
  notes: clearable,
  deviceCategory: categoryClearable,
  storageLocation: clearable,
} as const;

/** The admin item-edit page's field set (`/admin/items/[itemId]/edit`). */
export const adminItemEditSchema = z.object(editableItemFields);

export type AdminItemEditInput = z.infer<typeof adminItemEditSchema>;

/** The item detail card's ADMIN field set — identical by construction. */
export const itemDetailsSchema = z.object(editableItemFields);

export type ItemDetailsInput = z.infer<typeof itemDetailsSchema>;

// Fields a non-admin USER may edit from the item detail card: only who currently
// holds the device and where it is. deviceName/homeUnit/deviceUIC/notes/
// deviceCategory stay ADMIN-only (itemDetailsSchema). Because z.object() strips
// unknown keys, parsing a USER's submission through this schema discards any of
// those a crafted POST tries to smuggle in — the server, not the UI, is the
// authority. Do NOT widen this set to match the admin one.
export const userItemDetailsSchema = z.object({
  currentUserEmail: clearable,
  currentPosition: clearable,
});

export type UserItemDetailsInput = z.infer<typeof userItemDetailsSchema>;

/** Hard cap on one bulk action. The UI selects at most this many, but every
 *  bulk action is reachable by POST, so the server bounds it too.
 *
 *  Declared HERE rather than in items.service.ts because the /items selection
 *  is a Client Component and must be able to import it — items.service.ts
 *  imports Prisma, which must never reach the browser bundle. */
export const MAX_BULK_ITEMS = 500;
