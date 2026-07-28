"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import {
  markItemsReady,
  clearItemsReady,
  setItemsStatus,
  setItemsCategory,
  MAX_BULK_ITEMS,
} from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
import { MAX_CATEGORY_NAME } from "@/modules/items/items.schema";

/* ============================================================
   Bulk readiness + category actions for a selection of items.

   READINESS IS STILL DERIVED. Nothing here stores a readiness value — there is
   no column to store it in (Item.deployableStatus and ItemStatusHistory were
   dropped in 20260728000000_derive_readiness, and reintroducing either is
   forbidden). "Set readiness" is a convenience wrapper over the REAL underlying
   signals that readiness.ts already reads:

     Ready to deploy -> stamp   Item.markedReadyAt = now   (markItemsReady)
     Untriaged       -> clear   Item.markedReadyAt = null  (clearItemsReady)
     Retired         -> set     Item.status = RETIRED      (setItemsStatus)
     Active          -> set     Item.status = ACTIVE       (setItemsStatus)

   "Ready to deploy" routes through the SAME markItemsReady that the standalone
   "Mark as on hand" button uses, so the two controls can never disagree.

   DEPLOYED and IN_REPAIR are deliberately absent from the enum below, so a
   crafted POST asking for one is rejected by Zod rather than silently ignored.
   Neither is a thing a human asserts: DEPLOYED comes from an open unreturned
   hand receipt or an MDM last-logon, IN_REPAIR from a PENDING ServiceQueueItem.
   The UI renders them as disabled options that say so.

   ADMIN-ONLY, enforced here on the server. The UI hides these controls from a
   standard USER, but hiding is not a guard: requireAdmin() re-reads role +
   isActive from the DB per request, so a demoted or deactivated account loses
   them immediately. Kept out of updateItemDetailsAction's role-picked schema on
   purpose — that keeps the USER-editable field set exactly as narrow as it was
   (holder email + current position only).
   ============================================================ */

/** Shared id list. The cap is enforced here AND in the service functions: this
 *  one produces a readable message, the service one is the backstop for any
 *  other caller. */
const itemIdList = z
  .array(z.string().min(1))
  .min(1, "Select at least one item.")
  .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`);

/** The settable targets. NOT ReadinessState — "ACTIVE" is a lifecycle value,
 *  and DEPLOYED / IN_REPAIR are excluded because they are observed, not set.
 *
 *  NOT exported: every export of a `"use server"` module must be an async
 *  function, so the client keeps its own copy of the option list (the labels
 *  differ anyway) and this enum is the server-side backstop. */
const READINESS_TARGETS = ["READY_TO_DEPLOY", "UNTRIAGED", "RETIRED", "ACTIVE"] as const;

const setReadinessSchema = z.object({
  itemIds: itemIdList,
  target: z.enum(READINESS_TARGETS),
});

const setCategorySchema = z.object({
  itemIds: itemIdList,
  category: z
    .string()
    .trim()
    .min(1, "Choose a category.")
    .max(MAX_CATEGORY_NAME, `Category names are limited to ${MAX_CATEGORY_NAME} characters.`),
});

function idsFrom(formData: FormData): string[] {
  return String(formData.get("itemIds") ?? "")
    .split(",")
    .filter(Boolean);
}

/* Return shapes are ANNOTATED, not inferred. A `"use server"` module may only
   export async functions, so these types stay local — but naming them keeps the
   result a real discriminated union, which is what lets the client narrow with
   `"error" in res` / `"updated" in res` and get a `number` instead of a
   `number | undefined`. */
type ReadinessTarget = (typeof READINESS_TARGETS)[number];
type ReadinessResult =
  | { error: string }
  | { ok: true; updated: number; target: ReadinessTarget };
type CategoryResult =
  | { error: string }
  | { ok: true; updated: number; unchanged: number; category: string };

export async function setReadinessAction(formData: FormData): Promise<ReadinessResult> {
  await requireAdmin();

  const parsed = setReadinessSchema.safeParse({
    itemIds: idsFrom(formData),
    target: String(formData.get("target") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { itemIds, target } = parsed.data;

  try {
    const { updated } =
      target === "READY_TO_DEPLOY"
        ? await markItemsReady(itemIds)
        : target === "UNTRIAGED"
          ? await clearItemsReady(itemIds)
          : await setItemsStatus(itemIds, target);

    revalidatePath("/items");
    // Readiness feeds the analytics dashboard's fleet buckets.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, target };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[setReadinessAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
}

export async function setItemsCategoryAction(formData: FormData): Promise<CategoryResult> {
  const admin = await requireAdmin();

  const parsed = setCategorySchema.safeParse({
    itemIds: idsFrom(formData),
    category: String(formData.get("category") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { itemIds, category } = parsed.data;

  try {
    const { updated, unchanged } = await setItemsCategory(itemIds, category, {
      id: admin.id,
      name: admin.name,
    });
    revalidatePath("/items");
    // Category buckets the analytics volume chart.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, unchanged, category };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    if (e instanceof ItemError && e.code === "INVALID") {
      return { error: "Choose a category." };
    }
    console.error("[setItemsCategoryAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
}
