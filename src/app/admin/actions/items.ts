"use server";
import { revalidatePath } from "next/cache";
import { requireCapability, denyReadOnly } from "@/lib/authz";
import {
  createItem,
  getItemBySerial,
  updateItemFields,
  setItemStatus,
  deleteItem,
  analyzeImport,
  commitImport,
  markItemsReady,
  previewRename,
  renameItems,
  setItemsLoaner,
  type RenameCollision,
} from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
import { MAX_RENAME_PREFIX, RenameSequenceError } from "@/modules/items/rename-sequence";
import {
  newItemSchema,
  adminItemEditSchema,
  itemIdentitySchema,
  MAX_BULK_ITEMS,
} from "@/modules/items/items.schema";
import { Prisma } from "@prisma/client";
import { learnCategories, normalizeCategoryName } from "@/modules/items/categories.service";
import { z } from "zod";
import type { SkippedRow } from "@/modules/items/import";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;
  // Read off formData, NOT parsed.data: newItemSchema is a z.object() and
  // strips unknown keys, so these would silently vanish from the parsed result.
  const fromSearch = formData.get("fromSearch") === "1";
  const returnUic = String(formData.get("returnUic") ?? "").trim();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  let item;
  try {
    item = await createItem(data, admin.id);
  } catch (e) {
    // P2002 = unique-constraint violation. Item has exactly ONE unique column —
    // serialNumber, which is @db.Citext — so this can only mean an item already
    // holds that serial in some casing. Leaned on rather than pre-checked with a
    // findUnique, which would race. Reachable from the create-from-search flow:
    // /items?q=X&uic=Y shows "no matches" for an item that exists under a
    // DIFFERENT uic, and the empty state still offers to create it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      console.error("[createItemAction] serial collision:", e);
      const existing = await getItemBySerial(data.serialNumber);
      return {
        error: `Serial number "${data.serialNumber}" already belongs to an item. Serial numbers are unique and ignore case — open that item instead.`,
        existingItemId: existing?.id,
      };
    }
    console.error("[createItemAction] unexpected error:", e);
    return { error: "Something went wrong creating this item. Please try again." };
  }

  // A category typed directly into the form joins the vocabulary, so the managed
  // list keeps reflecting what is actually in the fleet. Outside the try, and
  // swallowing its own failure, because it is a SEPARATE transaction that runs
  // after the item write has committed — see the fuller note in
  // src/app/actions/items.ts.
  if (data.deviceCategory) {
    try {
      await learnCategories([data.deviceCategory]);
    } catch (e) {
      console.error("[createItemAction] learnCategories failed (item already created):", e);
    }
  }

  revalidatePath("/items");
  // The in-use counts on the category admin page go stale the moment
  // learnCategories registers a name; analytics counts the fleet.
  revalidatePath("/admin/categories");
  revalidatePath("/admin/analytics");

  // Was a redirect() to the filtered list, which meant the confirmation screen
  // never rendered on this path — so "open this item" would have been missing
  // exactly where items are created fastest. The destination is now a LINK, but
  // every property of the old redirect is preserved:
  //   * derived, never caller-supplied — the path is hardcoded and q is read off
  //     the row Prisma just wrote, so there is no target for anyone to craft;
  //   * URLSearchParams does the encoding, because concatenation mangles a
  //     serial containing &, #, + or a space and lands the admin on an empty
  //     list for the item they just created;
  //   * uic rides along ONLY when the new item satisfies it, since listItems
  //     filters deviceUIC by exact equality — returning with a filter the item
  //     does not match would hide the very row the link exists to show.
  let searchHref: string | undefined;
  if (fromSearch) {
    const params = new URLSearchParams({ q: item.serialNumber });
    if (returnUic && item.deviceUIC === returnUic) params.set("uic", returnUic);
    searchHref = `/items?${params}`;
  }

  return { itemId: item.id, searchHref };
}

// Admin edit of an item's eight editable fields (see `editableItemFields` in
// items.schema.ts). make/model/serialNumber are NOT among them — identity is
// corrected through its own form and its own action below
// (updateItemIdentityAction). Routes through the SAME updateItemFields as the
// user-level action so admin changes land in the same ItemEdit history rather
// than bypassing it.
export async function updateItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;
  const id = String(formData.get("id"));
  const parsed = adminItemEditSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  // Categories are stored on the item in the SAME canonical form the managed
  // vocabulary uses, or the two drift and the in-use count silently misses
  // (which would let an admin delete a category that is still assigned).
  const data = { ...parsed.data, deviceCategory: normalizeCategoryName(parsed.data.deviceCategory) };
  try {
    await updateItemFields(id, data, { id: admin.id, name: admin.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }
  // A category typed directly into the form joins the vocabulary, so the managed
  // list keeps reflecting what is actually in the fleet. Outside the try, and
  // swallowing its own failure, because it is a SEPARATE transaction that runs
  // after the item write has committed — see the fuller note in
  // src/app/actions/items.ts.
  if (data.deviceCategory) {
    try {
      await learnCategories([data.deviceCategory]);
    } catch (e) {
      console.error("[updateItemAction] learnCategories failed (item edit already saved):", e);
    }
  }
  revalidatePath("/items");
  revalidatePath(`/i/${id}`);
  return { ok: true };
}

// Correct an item's IDENTITY — make / model / serialNumber.
//
// Its own action, its own schema and its own form on /admin/items/[id]/edit,
// deliberately NOT folded into adminItemEditSchema's eight editable fields.
// A mistyped serial has to be correctable without a CSV round-trip, but the
// serial is the identity existing signed hand receipts refer to, so correcting
// one changes what those receipts appear to describe — that belongs behind a
// separate, deliberate submit rather than in the form you tab through to update
// a phone number.
//
// ADMIN-ONLY, enforced here on the server, and the ONLY surface that exposes
// these three: the item detail card (updateItemDetailsAction) still cannot
// touch them for any role, because editableItemFields does not declare them and
// z.object() strips what it does not declare.
//
// Routes through the SAME updateItemFields as every other edit, so the change
// is diffed and recorded in ItemEdit history rather than bypassing it.
export async function updateItemIdentityAction(_prev: unknown, formData: FormData) {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Missing item." };

  const parsed = itemIdentitySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await updateItemFields(id, parsed.data, { id: admin.id, name: admin.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    // P2002 = unique-constraint violation. Item has exactly ONE unique column —
    // serialNumber, which is @db.Citext — so a P2002 from this write can only
    // mean another item already holds that serial, in some casing ("abc123"
    // collides with "ABC123"). A case-only correction of THIS item's own serial
    // does not collide: it is the same row, so the index entry it would clash
    // with is its own, which the update replaces.
    //
    // Leaned on rather than pre-checked with a findUnique, which would race.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      console.error("[updateItemIdentityAction] serial collision:", e);
      return {
        error: `Serial number "${parsed.data.serialNumber}" is already on another item. Serial numbers are unique and ignore case, so open that item instead — or correct its serial first.`,
      };
    }
    console.error("[updateItemIdentityAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }

  revalidatePath("/items");
  revalidatePath(`/i/${id}`);
  // ALSO the edit page itself, unlike the other item actions. This is the only
  // action whose fields are echoed in that page's own header ("Make Model · SN
  // …", rendered server-side as read-only identification). Without this the
  // header still shows the OLD serial directly above a form that just reported
  // saving the new one, which reads as the save having failed.
  revalidatePath(`/admin/items/${id}/edit`);
  return { ok: true };
}

// "Mark as on hand" — from the /items selection bar or a single item page.
//
// This replaces the old bulk "set readiness" control. Readiness is no longer a
// stored enum an admin picks from a dropdown; it is DERIVED (readiness.ts), and
// this stamps the ONE signal a human owns: markedReadyAt = "this device is back
// on my shelf right now". Everything else about the state — in repair, issued
// out, logged on since — the app already knows.
//
// Requires MANAGE_ITEMS, enforced here on the server. The UI hides the button
// from anyone without it, but hiding is not a guard: requireCapability re-reads
// role, isActive AND the capability grants from the DB per request, so a
// demoted account — or one whose grant was revoked — loses this immediately.
// Deliberately NOT folded into updateItemDetailsAction's capability-picked
// schema — routing it through its own action keeps the holder-only editable
// field set exactly as narrow as it was.
const markReadySchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item."),
});

export async function markItemsReadyAction(formData: FormData) {
  const actor = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(actor);
  if (denied) return denied;

  const parsed = markReadySchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const { updated } = await markItemsReady(parsed.data.itemIds);
    revalidatePath("/items");
    revalidatePath("/admin/analytics");
    return { ok: true, updated };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[markItemsReadyAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
}

const setLoanerSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item."),
  isLoaner: z.boolean(),
});

/* Annotated, not inferred: a "use server" module may only export async
   functions, so the union stays a local type — which is what lets the client
   narrow with `"error" in res` and get a number rather than number | undefined. */
type LoanerResult =
  | { error: string }
  | { ok: true; updated: number; skipped: number; isLoaner: boolean };

/**
 * Mark the selected items as loaner-pool stock, or take them out of it.
 *
 * MANAGE_ITEMS, not ADMINISTER: this is item vocabulary, the same capability
 * the rename and category controls use. The batch is client-supplied ids, so
 * this guard is the entire boundary — the sheet hiding the buttons is
 * presentation, not security.
 *
 * Revalidates /items only. Not /admin/analytics: nothing on the dashboard reads
 * this flag yet, and that entry must be added when the loaner bucket ships.
 * Not the 500 individual /i/<id> paths either — setReadinessAction sets that
 * precedent, and the item page picks the badge up on its next render.
 */
export async function setItemsLoanerAction(formData: FormData): Promise<LoanerResult> {
  const actor = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(actor);
  if (denied) return denied;

  const parsed = setLoanerSchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    // Exactly "1" is on. Anything else is off, so a malformed value cannot
    // accidentally mark a batch.
    isLoaner: String(formData.get("isLoaner") ?? "") === "1",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const { updated, skipped } = await setItemsLoaner(parsed.data.itemIds, parsed.data.isLoaner);
    revalidatePath("/items");
    return { ok: true, updated, skipped, isLoaner: parsed.data.isLoaner };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[setItemsLoanerAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
}

/** Shared shape for both rename actions. `itemIds` order IS the numbering, so
 *  this must NOT sort or re-order — only drop blanks. */
const renameSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
  prefix: z
    .string()
    .trim()
    .min(1, "Enter a name prefix.")
    .max(MAX_RENAME_PREFIX, `Prefixes are limited to ${MAX_RENAME_PREFIX} characters.`),
  start: z.string().regex(/^\d+$/, "Start must be a whole number, like 001."),
});

function renameInput(formData: FormData) {
  return {
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    prefix: String(formData.get("prefix") ?? ""),
    start: String(formData.get("start") ?? ""),
  };
}

type RenamePreviewResult =
  | { error: string }
  | { ok: true; count: number; first: string; last: string; skipped: number; collisions: RenameCollision[] };

type RenameActionResult =
  | { error: string }
  | { conflict: true; collisions: RenameCollision[] }
  | { ok: true; renamed: number; unchanged: number; skipped: number };

/** What the rename WOULD do — drives the sheet's range line and collision list.
 *  Advisory: renameItemsAction re-checks inside its transaction. */
export async function previewItemRenameAction(formData: FormData): Promise<RenamePreviewResult> {
  await requireCapability("MANAGE_ITEMS");

  const parsed = renameSchema.safeParse(renameInput(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const out = await previewRename(parsed.data.itemIds, parsed.data.prefix, parsed.data.start);
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof RenameSequenceError) return { error: "Check the prefix and start number." };
    console.error("[previewItemRenameAction] unexpected error:", e);
    return { error: "Couldn't work out those names. Please try again." };
  }
}

/**
 * Rename every selected item to a consecutive PREFIX-NNN sequence.
 *
 * The client posts ONLY ids, a prefix and a start. Any `names` field it sends is
 * ignored — `z.object()` strips it and the service rebuilds the sequence itself.
 * Accepting a name list would turn this into "write any string to any item".
 */
export async function renameItemsAction(formData: FormData): Promise<RenameActionResult> {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;

  const parsed = renameSchema.safeParse(renameInput(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const res = await renameItems(parsed.data.itemIds, parsed.data.prefix, parsed.data.start, {
      id: admin.id,
      name: admin.name,
    });
    if (!res.ok) return { conflict: true, collisions: res.collisions };

    revalidatePath("/items");
    return { ok: true, renamed: res.renamed, unchanged: res.unchanged, skipped: res.skipped };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    if (e instanceof RenameSequenceError) return { error: "Check the prefix and start number." };
    console.error("[renameItemsAction] unexpected error:", e);
    return { error: "Something went wrong renaming those items. Please try again." };
  }
}

export async function toggleItemStatusAction(formData: FormData) {
  const actor = await requireCapability("MANAGE_ITEMS");
  // void return: nowhere to render the refusal — the read-only
  // banner in the admin layout is what stops this reading as a bug.
  if (denyReadOnly(actor)) return;
  const id = String(formData.get("id"));
  const next = formData.get("status") === "RETIRED" ? "RETIRED" : "ACTIVE";
  await setItemStatus(id, next);
  revalidatePath("/items");
}

// Permanent delete — ADMIN-only, no undo. Offered beside Retire for a row that
// should never have existed (a duplicate from a mistyped serial, a bad CSV
// row); Retire is the reversible option for a device that is simply out of
// service. deleteItem() itself enforces NO permissions (see its docstring in
// items.service.ts) — this action is the entire authorization boundary.
//
// Hand receipts are unaffected: TransferItem.itemId is nullable with
// ON DELETE SET NULL, so a receipt line detaches from the deleted item but
// keeps its own snapshot (serialNumber/make/model on the line, signatures on
// the transfer) exactly as issued.
export async function deleteItemAction(formData: FormData) {
  const actor = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(actor);
  if (denied) return denied;
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "No item was specified." };
  try {
    await deleteItem(id);
  } catch (e) {
    // P2025 = record not found. A double submit, or two admins on the same row.
    // Not an error worth alarming anyone with: the outcome they asked for holds.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      revalidatePath("/items");
      return;
    }
    console.error("[deleteItemAction] unexpected error:", e);
    return { error: "Something went wrong deleting this item. Please try again." };
  }
  revalidatePath("/items");
  revalidatePath("/admin/analytics");
}

function readCsvFile(formData: FormData): { file: File } | { error: string } {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "The file must be a .csv file." };
  return { file };
}

export async function analyzeImportAction(
  formData: FormData
): Promise<{ counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number }; skipped: SkippedRow[]; mismatches: { serialNumber: string }[] } | { error: string }> {
  await requireCapability("MANAGE_ITEMS");
  const f = readCsvFile(formData);
  if ("error" in f) return f;
  try {
    const text = await f.file.text();
    const res = await analyzeImport(text);
    if (res.error) return { error: res.error };
    return { counts: res.counts, skipped: res.skipped, mismatches: res.mismatches };
  } catch (e) {
    console.error("[analyzeImportAction] unexpected error:", e);
    return { error: "Something went wrong reading the file. Please try again." };
  }
}

export async function commitImportAction(
  formData: FormData
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; mismatches: { serialNumber: string }[] } | { error: string }> {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;
  const f = readCsvFile(formData);
  if ("error" in f) return f;

  try {
    const text = await f.file.text();
    const res = await commitImport(text, f.file.name, { id: admin.id, name: admin.name });
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, updated: res.updated, skipped: res.skipped, unchanged: res.unchanged, mismatches: res.mismatches };
  } catch (e) {
    console.error("[commitImportAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
