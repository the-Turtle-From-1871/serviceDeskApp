"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markItemsReadyAction } from "@/app/admin/actions/items";

/**
 * Admin-only "Mark as on hand" — the one readiness signal a human sets.
 *
 * Shared by the /items selection bar (many ids) and the item detail page (one),
 * so the wording and the outcome message cannot drift between the two surfaces.
 *
 * Rendered only for admins, but that is presentation — markItemsReadyAction
 * re-checks with requireAdmin(), which is the actual boundary.
 *
 * NOT a plain <form action={...}>: the action returns a result object so the
 * caller can report "0 changed", which React's form-action signature (void)
 * cannot carry back.
 */
export function MarkReadyButton({
  itemIds,
  onDone,
  variant = "btn-secondary",
}: {
  itemIds: string[];
  onDone?: () => void;
  variant?: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = () => {
    setMessage(null);
    const fd = new FormData();
    fd.set("itemIds", itemIds.join(","));

    startTransition(async () => {
      const res = await markItemsReadyAction(fd);
      if ("error" in res && res.error) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      const n = "updated" in res ? res.updated : 0;
      setMessage({
        ok: true,
        // "0 changed" is a real outcome — every selected item was retired, so
        // "back on the shelf" does not apply. Report it rather than implying
        // work happened.
        text: n === 0 ? "Nothing to mark — those items are retired." : `Marked ${n} item${n === 1 ? "" : "s"} on hand.`,
      });
      onDone?.();
      router.refresh();
    });
  };

  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button
        type="button"
        className={`btn ${variant}`}
        disabled={pending || itemIds.length === 0}
        onClick={apply}
        title="Record that these devices are physically back in our possession"
      >
        {pending ? "Marking…" : "Mark as on hand"}
      </button>
      {message && <span role="status" className={message.ok ? "subtle" : "alert-error"}>{message.text}</span>}
    </div>
  );
}
