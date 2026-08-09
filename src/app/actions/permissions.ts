"use server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireCapability } from "@/lib/authz";
import { defaultBaseUrl } from "@/lib/base-url";
import {
  createPermissionRequest,
  decidePermissionRequest,
} from "@/modules/users/permissions.service";
import { PermissionRequestError } from "@/modules/users/permissions.errors";
import {
  permissionDecisionSchema,
  permissionRequestSchema,
} from "@/modules/users/permissions.schema";
import { sendDecisionEmail } from "@/modules/auth/send-decision-email";

const REQUEST_MESSAGES: Record<string, string> = {
  ALREADY_HELD: "You already have one of those permissions.",
  ALREADY_PENDING: "You have already asked for one of those and it is still being reviewed.",
  NOT_FOUND: "That request no longer exists.",
  ALREADY_DECIDED: "That request has already been decided.",
  SELF_DECISION: "You cannot decide your own permission request. Ask another administrator.",
  REASON_REQUIRED: "Give a reason for anything you are not granting.",
};

function messageFor(e: unknown): string | null {
  return e instanceof PermissionRequestError ? REQUEST_MESSAGES[e.code] ?? null : null;
}

/**
 * Files a request. Gated on VIEW_INVENTORY — the baseline every signed-in
 * account holds — because a VIEWER asking for more is the entire point of this
 * feature.
 *
 * The requester is taken from the SESSION, never from the form: a userId field
 * would let anyone file a request in someone else's name, and the justification
 * attached to a grant is only meaningful if the person it names actually wrote
 * it.
 */
export async function requestPermissionsAction(_prev: unknown, formData: FormData) {
  const user = await requireCapability("VIEW_INVENTORY");

  const parsed = permissionRequestSchema.safeParse({
    justification: String(formData.get("justification") ?? ""),
    capabilities: formData.getAll("capabilities").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  try {
    await createPermissionRequest(user.id, parsed.data);
  } catch (e) {
    const known = messageFor(e);
    if (known) return { error: known };
    console.error("[requestPermissionsAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }

  revalidatePath("/account");
  revalidatePath("/admin/permissions");
  return { ok: true as const };
}

/**
 * Decides a request. `approve` is the set of CHECKED boxes; every other line on
 * the request is denied, because the admin decides by unchecking.
 *
 * The decider is the session user, which is also what makes the self-decision
 * guard in the service meaningful — a form-supplied decider id would defeat it.
 */
export async function decidePermissionRequestAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();

  const parsed = permissionDecisionSchema.safeParse({
    requestId: String(formData.get("requestId") ?? ""),
    approve: formData.getAll("approve").map(String),
    denialReason: String(formData.get("denialReason") ?? "") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  let decided;
  try {
    decided = await decidePermissionRequest({
      requestId: parsed.data.requestId,
      deciderId: admin.id,
      approve: parsed.data.approve,
      denialReason: parsed.data.denialReason,
    });
  } catch (e) {
    const known = messageFor(e);
    if (known) return { error: known };
    console.error("[decidePermissionRequestAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }

  // Deferred and failure-swallowing: the decision has already committed, and a
  // mail outage must not report the grant as failed — the requester would ask
  // again and an admin would grant it twice.
  after(async () => {
    try {
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base || !decided.user?.email) return;
      await sendDecisionEmail({
        to: decided.user.email,
        name: decided.user.name,
        approved: decided.items.filter((i) => i.decision === "APPROVED").map((i) => i.capability),
        denied: decided.items.filter((i) => i.decision === "DENIED").map((i) => i.capability),
        denialReason: decided.denialReason,
        accountUrl: `${base}/account`,
      });
    } catch (e) {
      console.error("[decidePermissionRequestAction] decision email failed:", e);
    }
  });

  revalidatePath("/admin/permissions");
  revalidatePath("/account");
  return { ok: true as const };
}
