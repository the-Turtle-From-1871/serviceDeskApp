"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import {
  createItem,
  getItemBySerial,
  updateItemFields,
  setItemStatus,
  deleteItem,
  analyzeImport,
  commitImport,
  markItemsReady,
  MAX_BULK_ITEMS,
} from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
import {
  newItemSchema,
  adminItemEditSchema,
  itemIdentitySchema,
} from "@/modules/items/items.schema";
import { Prisma } from "@prisma/client";
import { learnCategories, normalizeCategoryName } from "@/modules/items/categories.service";
import { z } from "zod";
import { resolutionSchema, type UnitResolution } from "@/modules/items/units.service";
import type { SkippedRow, UnresolvedRow } from "@/modules/items/import";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
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

// Admin edit of an item's seven editable fields (see `editableItemFields` in
// items.schema.ts). make/model/serialNumber are NOT among them — identity is
// corrected through its own form and its own action below
// (updateItemIdentityAction). Routes through the SAME updateItemFields as the
// user-level action so admin changes land in the same ItemEdit history rather
// than bypassing it.
export async function updateItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
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
// deliberately NOT folded into adminItemEditSchema's seven editable fields.
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
  const admin = await requireAdmin();
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
// ADMIN-ONLY, enforced here on the server. The UI hides the button from a
// standard USER, but hiding is not a guard: requireAdmin() re-reads role +
// isActive from the DB per request, so a demoted account loses this
// immediately. Deliberately NOT folded into updateItemDetailsAction's
// role-picked schema — routing it through its own action keeps the
// USER-editable field set exactly as narrow as it was.
const markReadySchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item."),
});

export async function markItemsReadyAction(formData: FormData) {
  await requireAdmin();

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

export async function toggleItemStatusAction(formData: FormData) {
  await requireAdmin();
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
  await requireAdmin();
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
): Promise<{ counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number }; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; mismatches: { serialNumber: string }[] } | { error: string }> {
  await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;
  try {
    const text = await f.file.text();
    const res = await analyzeImport(text);
    if (res.error) return { error: res.error };
    return { counts: res.counts, skipped: res.skipped, unresolved: res.unresolved, mismatches: res.mismatches };
  } catch (e) {
    console.error("[analyzeImportAction] unexpected error:", e);
    return { error: "Something went wrong reading the file. Please try again." };
  }
}

export async function commitImportAction(
  formData: FormData
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[] } | { error: string }> {
  const admin = await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;

  let resolutions: UnitResolution[];
  try {
    const raw = JSON.parse(String(formData.get("resolutions") ?? "[]"));
    resolutions = z.array(resolutionSchema).parse(raw);
  } catch {
    return { error: "The unit assignments were invalid. Please re-check them and try again." };
  }

  try {
    const text = await f.file.text();
    const res = await commitImport(text, f.file.name, resolutions, { id: admin.id, name: admin.name });
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, updated: res.updated, skipped: res.skipped, unchanged: res.unchanged, detected: res.detected, mismatches: res.mismatches };
  } catch (e) {
    console.error("[commitImportAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
