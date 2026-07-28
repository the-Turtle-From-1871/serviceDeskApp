"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setReadinessAction, setItemsCategoryAction } from "@/app/admin/actions/readiness";
import { READINESS_LABEL } from "@/components/items-view";

/**
 * Admin-only bulk "Set readiness" + "Change category" for a selection of items.
 *
 * Works for ONE item as well as a page selection — the /items action bar passes
 * the whole selection, the item detail page passes a single id. Same component,
 * so the wording and the outcome messages cannot drift between the two.
 *
 * READINESS IS NOT STORED. This select does not write a readiness value (there
 * is no column for one); it writes the real underlying signals readiness.ts
 * derives from — markedReadyAt for the two readiness rows, Item.status for the
 * two lifecycle rows. See src/app/admin/actions/readiness.ts.
 *
 * "Ready to deploy" calls the SAME markItemsReady service function as the
 * standalone MarkReadyButton, which stays on the page as the one-click fast
 * path. Two entry points, one implementation.
 *
 * Rendered only for admins, but that is presentation — both actions re-check
 * with requireAdmin(), which is the actual boundary.
 *
 * NOT plain <form action={...}>: the actions return a result object so the
 * caller can report "0 changed", which React's form-action signature (void)
 * cannot carry back. Mirrors MarkReadyButton.
 */

type Msg = { ok: boolean; text: string } | null;

/** Targets a human can actually assert, in the order they are offered. */
const SETTABLE = [
  { value: "READY_TO_DEPLOY", label: READINESS_LABEL.READY_TO_DEPLOY },
  // Labelled by the ACTION, not by an outcome it cannot promise. Clearing the
  // on-hand mark only reads as "Untriaged" when nothing else is known about the
  // device; if it has an MDM logon or sits on an open receipt, those signals
  // were being outranked by the mark and the row lands on "Deployed" the moment
  // it is cleared. Observed in testing: an item marked ready read "Deployed"
  // right after picking this, which looks like a broken control when the option
  // is labelled with a state. "Clear the on-hand mark" is always exactly what
  // happens.
  { value: "UNTRIAGED", label: "Clear the on-hand mark" },
  { value: "RETIRED", label: READINESS_LABEL.RETIRED },
  // Not a readiness state — the lifecycle inverse of Retired. Offered here so
  // un-retiring is reachable from the same control that retires. (On /items
  // only ACTIVE rows are selectable, so this option matters mainly on the
  // single-item surface; each row also has its own Reactivate button.)
  { value: "ACTIVE", label: "Active (un-retire)" },
] as const;

/** Offered but disabled, with the reason in the label. Showing WHY these cannot
 *  be picked is the point — silently omitting them would read as a missing
 *  feature rather than a deliberate one. The server enum excludes them too, so
 *  a crafted POST is rejected, not merely un-clickable. */
const DERIVED_ONLY = [
  { value: "DEPLOYED", label: `${READINESS_LABEL.DEPLOYED} — set by issuing a hand receipt` },
  { value: "IN_REPAIR", label: `${READINESS_LABEL.IN_REPAIR} — set by the service queue` },
] as const;

function plural(n: number) {
  return n === 1 ? "" : "s";
}

function readinessMessage(target: string, n: number): string {
  switch (target) {
    case "READY_TO_DEPLOY":
      return n === 0
        ? "Nothing to mark — those items are retired."
        : `Marked ${n} item${plural(n)} on hand.`;
    case "UNTRIAGED":
      return n === 0
        ? "Nothing to clear — none of those were marked on hand."
        : `Cleared the on-hand mark on ${n} item${plural(n)}.`;
    case "RETIRED":
      return n === 0
        ? "Nothing to change — those items are already retired."
        : `Retired ${n} item${plural(n)}.`;
    default:
      return n === 0
        ? "Nothing to change — those items are already active."
        : `Reactivated ${n} item${plural(n)}.`;
  }
}

export function ReadinessControls({
  itemIds,
  categories,
}: {
  itemIds: string[];
  categories: { name: string }[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [category, setCategory] = useState("");
  const [readinessMsg, setReadinessMsg] = useState<Msg>(null);
  const [categoryMsg, setCategoryMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();

  const none = itemIds.length === 0;

  const applyReadiness = () => {
    setReadinessMsg(null);
    const fd = new FormData();
    fd.set("itemIds", itemIds.join(","));
    fd.set("target", target);

    startTransition(async () => {
      const res = await setReadinessAction(fd);
      if ("error" in res && res.error) {
        setReadinessMsg({ ok: false, text: res.error });
        return;
      }
      const n = "updated" in res ? res.updated : 0;
      setReadinessMsg({ ok: true, text: readinessMessage(target, n) });
      setTarget("");
      // Deliberately does NOT clear the selection. Clearing it unmounts the
      // sticky bar this component lives in, which destroys the message written
      // on the line above — the user's only confirmation that anything
      // happened. That matters most in exactly the confusing case: clearing an
      // on-hand mark can leave a row reading "Deployed", and "Cleared the
      // on-hand mark on 1 item." is what explains it. Keeping the selection
      // also lets you set readiness and then a category in one pass.
      router.refresh();
    });
  };

  const applyCategory = () => {
    setCategoryMsg(null);
    const fd = new FormData();
    fd.set("itemIds", itemIds.join(","));
    fd.set("category", category);

    startTransition(async () => {
      const res = await setItemsCategoryAction(fd);
      if ("error" in res && res.error) {
        setCategoryMsg({ ok: false, text: res.error });
        return;
      }
      const n = "updated" in res ? res.updated : 0;
      const already = "unchanged" in res ? res.unchanged : 0;
      setCategoryMsg({
        ok: true,
        text:
          n === 0
            ? `All selected items are already "${category}".`
            : `Set ${n} item${plural(n)} to "${category}".` +
              (already > 0 ? ` ${already} already had it.` : ""),
      });
      setCategory("");
      // Selection deliberately kept — see the note in applyReadiness.
      router.refresh();
    });
  };

  // ONE wrapping row, not two stacked blocks: this sits inside the /items sticky
  // selection bar, which overlays the table. Every extra line of height hides
  // another row of the thing you are selecting from — on a phone the stacked
  // version covered the entire viewport and pushed "Change category" off-screen.
  // Both control groups sit beside "Mark as on hand" on a wide screen and wrap
  // to their own lines when there is no room.
  //
  // The long "why can't I pick Deployed" prose that used to live here is gone on
  // purpose: the disabled options already say "— set by issuing a hand receipt"
  // and "— set by the service queue" at the point of the question, which is
  // where the answer belongs. The one genuinely non-obvious part (those signals
  // OUTRANK what you set here) is on the select's title instead of costing four
  // lines of a bar that is covering the table.
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        {/* Each select and its Apply are ONE non-wrapping group. Left as four
            loose siblings, a narrow viewport wrapped between a select and its
            own button — putting the readiness "Apply" directly beside the
            "Change category" dropdown, where it read as that select's button.
            Wrapping is allowed BETWEEN groups, never inside one. */}
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "nowrap" }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="subtle" style={{ fontSize: 12 }}>Set readiness</span>
            <select
              className="select toolbar__control"
              value={target}
              disabled={pending || none}
              onChange={(e) => setTarget(e.target.value)}
              title="Readiness is derived from live signals. An open hand receipt, an MDM logon, or a service-queue entry outranks what you set here — marking an item on hand while it is still on an open receipt will leave it reading Deployed."
            >
              <option value="">Choose…</option>
              {SETTABLE.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              <optgroup label="Derived — not set by hand">
                {DERIVED_ONLY.map((o) => (
                  <option key={o.value} value={o.value} disabled>{o.label}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || none || !target}
            onClick={applyReadiness}
            title="Apply this readiness to the selected items"
          >
            {pending ? "Applying…" : "Apply"}
          </button>
        </div>

        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "nowrap" }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="subtle" style={{ fontSize: 12 }}>Change category</span>
            <select
              className="select toolbar__control"
              value={category}
              disabled={pending || none || categories.length === 0}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || none || !category}
            onClick={applyCategory}
            title="Assign this category to the selected items"
          >
            {pending ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>

      {/* Outcomes live on their own line so a long message can never reflow the
          controls above it mid-interaction. */}
      {(readinessMsg || categoryMsg || categories.length === 0) && (
        <div className="stack" style={{ gap: 2 }}>
          {readinessMsg && (
            <span role="status" className={readinessMsg.ok ? "subtle" : "alert-error"}>
              {readinessMsg.text}
            </span>
          )}
          {categoryMsg && (
            <span role="status" className={categoryMsg.ok ? "subtle" : "alert-error"}>
              {categoryMsg.text}
            </span>
          )}
          {categories.length === 0 && (
            <span className="subtle">No categories yet — add them under Admin → Categories.</span>
          )}
        </div>
      )}
    </div>
  );
}
