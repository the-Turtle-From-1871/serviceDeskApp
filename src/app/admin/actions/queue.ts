"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { removeFromQueue } from "@/modules/service-queue/service-queue.service";
import { ServiceQueueError } from "@/modules/service-queue/service-queue.errors";

const removeSchema = z.object({ id: z.string().min(1) });

// Admin removes an item from the Admin Queue. The backend does NOT delete it —
// removeFromQueue transitions it to "Ready to issue when needed". Admin-guarded;
// errors are logged server-side and swallowed so the page simply re-renders.
export async function removeFromQueueAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = removeSchema.safeParse({ id: String(formData.get("id") ?? "") });
  if (!parsed.success) return;
  try {
    await removeFromQueue(parsed.data.id);
  } catch (e) {
    // ServiceQueueError (not-found / already-removed) is an expected no-op; only
    // log unexpected failures with detail. Never leak specifics to the client.
    if (!(e instanceof ServiceQueueError)) {
      console.error("[removeFromQueueAction] unexpected error:", e);
    }
  }
  revalidatePath("/admin/queue");
}
