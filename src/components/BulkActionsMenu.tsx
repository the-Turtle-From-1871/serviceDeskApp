"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { recordAuditsAction } from "@/app/admin/actions/audit";
import { flagItemsForServiceAction, completeServiceItemsAction } from "@/app/admin/actions/queue";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";
import { useDismissSwallowsTap } from "./SortFilterMenu";

type Msg = { ok: boolean; text: string } | null;

type BulkResult = { error: string } | { ok: true; updated: number; skipped: number };

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Audited 47 items. Skipped 2 (retired or not applicable)." — the skip count
 *  is never silent: all three of these actions pass over rows they cannot act
 *  on (retired kit, or an item with no pending queue row), and an operator who
 *  scanned 49 devices must be told 2 did nothing. Reporting rather than
 *  refusing is the cross-cutting rule for bulk actions here, and it diverges
 *  from the single-item `markAuditedAction` on purpose. */
function outcome(verb: string, updated: number, skipped: number): string {
  const head = `${verb} ${updated} item${plural(updated)}.`;
  return skipped > 0 ? `${head} Skipped ${skipped} (retired or not applicable).` : head;
}

/**
 * The /items selection bar's overflow sheet: the three bulk actions that need
 * inputs of their own and cannot fit inline. The bar is sticky and overlays the
 * table, so every line of height hides another row of what you are selecting
 * from — stacked inline, these three covered a phone viewport entirely.
 *
 * THIS COMPONENT honours `canAudit` and `canQueue` independently — each group
 * renders only when its flag is set, and neither means no trigger at all.
 * ITS ONE CALLER CURRENTLY DOES NOT EXERCISE THAT. `/items` mounts the whole
 * bulk row behind `isAdmin` (`user.role === "ADMIN"`), and the ADMIN baseline is
 * all nine capabilities, so the only combination that ever reaches this
 * component today is `(true, true)`. A `USER` granted `MANAGE_QUEUE`
 * individually does NOT see the service actions here — see the note at the
 * mount site in ItemSelectTable. The independent gating is kept because it is
 * real, it is what a second caller or a widened wrapper would need, and it
 * costs nothing.
 *
 * Either way this is PRESENTATION, never a boundary: `recordAuditsAction` calls
 * `requireAdmin()` (= `requireCapability("ADMINISTER")`) and both queue actions
 * call `requireCapability("MANAGE_QUEUE")`, re-read from the DB per request. The
 * batch is client-supplied ids, so that server guard is the whole of it — the
 * `isAdmin` wrapper above is a VISIBILITY gap, not a security one, and nothing
 * is over-exposed by it.
 *
 * Only ids are posted. For the audit, the signer's name and image are re-read
 * server-side scoped to the acting admin — the browser is handed signature
 * NAMES only (`listSignatureNames`) and never any ink.
 *
 * POPOVER RULES — all inherited from SortFilterMenu and all load-bearing:
 *  - The element carrying `popover` has NO className. An author `display` beats
 *    the UA's `[popover]:not(:popover-open) { display: none }`, and every closed
 *    sheet would then render and swallow the taps meant for the bar beneath it.
 *    That has shipped twice here (the delete <dialog>, then this).
 *  - `useDismissSwallowsTap` spends the dismissing tap in the CAPTURE phase;
 *    light dismiss closes on pointerdown and still delivers the click to
 *    whatever sits underneath. Imported, never re-implemented.
 *  - Styled BY ID (#items-bulkactions), listed in all four globals.css rule
 *    groups. There is deliberately no shared class to inherit from — and note
 *    this is the SECOND popover menu on /items, so the anchored block also
 *    takes the trigger out of the shared `--sortfilter-trigger` anchor name.
 */
export function BulkActionsMenu({
  itemIds,
  signatures,
  canAudit,
  canQueue,
}: {
  itemIds: string[];
  /** Names only — `listSignatureNames`. No image blob reaches the browser. */
  signatures: { id: string; name: string }[];
  canAudit: boolean;
  canQueue: boolean;
}) {
  const menuId = "items-bulkactions";
  const triggerId = "items-bulkactions-trigger";
  useDismissSwallowsTap(menuId, triggerId);
  const router = useRouter();

  const [signatureId, setSignatureId] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [note, setNote] = useState("");
  const [auditMsg, setAuditMsg] = useState<Msg>(null);
  // ONE message for both queue actions, knowingly: Flag and Complete are two
  // ends of the same job and are not used together, so a second line of height
  // in a bar that already covers a phone viewport buys nothing. The known cost
  // is that firing the second while the first is still in flight overwrites its
  // outcome — the transitions are separate, so the writes themselves never
  // interfere, only the report of the earlier one.
  const [queueMsg, setQueueMsg] = useState<Msg>(null);
  // THREE transitions, not one. These are independent operations sharing a
  // panel, and with a single `pending` flag a slow bulk write points the busy
  // state at the wrong control and disables the other two. Same reasoning as
  // ReadinessControls.
  const [auditPending, startAudit] = useTransition();
  const [flagPending, startFlag] = useTransition();
  const [completePending, startComplete] = useTransition();

  const none = itemIds.length === 0;
  const ids = itemIds.join(",");

  /** Post one batch and report its outcome. The selection is deliberately KEPT
   *  — clearing it unmounts the sticky bar this sheet lives in, destroying the
   *  message that is the only confirmation anything happened, and a 150-device
   *  batch cost real physical effort to collect. `router.refresh()` is what
   *  repaints the badges the action just moved. */
  const run = (
    start: React.TransitionStartFunction,
    setMsg: (m: Msg) => void,
    fields: Record<string, string>,
    call: (fd: FormData) => Promise<BulkResult>,
    verb: string,
  ) => {
    setMsg(null);
    const fd = new FormData();
    fd.set("itemIds", ids);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    start(async () => {
      const res = await call(fd);
      if ("error" in res) {
        setMsg({ ok: false, text: res.error });
        return;
      }
      setMsg({ ok: true, text: outcome(verb, res.updated, res.skipped) });
      router.refresh();
    });
  };

  // Nothing this caller may do — render no trigger at all rather than a button
  // that opens onto an empty sheet. Placed after the hooks, which must not sit
  // behind a conditional return.
  if (!canAudit && !canQueue) return null;

  return (
    <>
      <button
        type="button"
        id={triggerId}
        className="btn btn-secondary menu-trigger"
        popoverTarget={menuId}
        disabled={none}
      >
        <span className="menu-trigger__label">More actions</span>
        {/* An SVG, not a "⌄" glyph: a text chevron is placed by font metrics and
            sits high in its em box. Same reasoning as SortFilterMenu. */}
        <ChevronDown className="menu-trigger__chevron" aria-hidden="true" />
      </button>

      {/* NO className on this element. See the trap note above. */}
      <div id={menuId} popover="auto">
        <div className="popup-menu__panel stack-sm">
          {canAudit && (
            <div className="stack" style={{ gap: 6 }}>
              {/* A real <label htmlFor>, so the select's accessible name is the
                  caption and tapping the caption opens the picker. */}
              <label className="label" htmlFor="bulk-sig">Sign as</label>
              <select
                id="bulk-sig"
                className="select"
                value={signatureId}
                disabled={auditPending || none || signatures.length === 0}
                onChange={(e) => setSignatureId(e.target.value)}
              >
                <option value="">Choose…</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={auditPending || none || !signatureId}
                onClick={() => {
                  // The one control here that writes accountability records —
                  // it asserts that a named person laid eyes on every one of
                  // these devices, and there is no undo. The confirm names the
                  // count AND the signer, because both are things a mistap gets
                  // wrong (the wrong batch rehydrated from a previous sweep, or
                  // the wrong name left in the picker).
                  const signer = signatures.find((s) => s.id === signatureId)?.name ?? "";
                  const ok = window.confirm(
                    `Record an audit for ${itemIds.length} item${plural(itemIds.length)}, signed as ${signer}?\n\n` +
                    `This writes an accountability record for each device and cannot be undone.`,
                  );
                  if (!ok) return;
                  run(startAudit, setAuditMsg, { signatureId }, recordAuditsAction, "Audited");
                }}
              >
                {auditPending ? "Recording…" : `Audit ${itemIds.length} item${plural(itemIds.length)}`}
              </button>
              {/* An empty picker with no explanation reads as a broken control;
                  the capability is held, the ink simply does not exist yet. */}
              {signatures.length === 0 && (
                <span className="subtle">No saved signatures — add one under Account.</span>
              )}
              {/* role="alert" on a failure, "status" on a success. A polite
                  live region carrying .alert-error is an error a screen-reader
                  user is never told about; the same bar already uses "alert"
                  for its receipt errors. */}
              {auditMsg && (
                <span role={auditMsg.ok ? "status" : "alert"} className={auditMsg.ok ? "subtle" : "alert-error"}>{auditMsg.text}</span>
              )}
            </div>
          )}

          {canQueue && (
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="bulk-service">Service type</label>
              <select
                id="bulk-service"
                className="select"
                value={serviceType}
                disabled={flagPending || none}
                onChange={(e) => setServiceType(e.target.value)}
              >
                <option value="">Choose…</option>
                {SERVICE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {/* Not `required`: a browser-side constraint on a control that is
                  not inside a <form> buys nothing, and the server already
                  refuses OTHER with no note (NOTE_REQUIRED → a real message). */}
              <input
                className="input"
                aria-label="Service note"
                placeholder={serviceType === "OTHER" ? "What needs doing? (required)" : "Note (optional)"}
                value={note}
                disabled={flagPending || none}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={flagPending || none || !serviceType}
                onClick={() =>
                  run(
                    startFlag,
                    setQueueMsg,
                    { serviceType, note },
                    flagItemsForServiceAction,
                    "Flagged",
                  )
                }
              >
                {flagPending ? "Flagging…" : "Flag for service"}
              </button>

              {/* No deadline field: `overrideDays` is never posted, so a blank
                  means no deadline on create and no change on update — the
                  documented behaviour of a blank, and the batch has no per-item
                  "already flagged?" state a form could branch on. */}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={completePending || none}
                onClick={() =>
                  run(
                    startComplete,
                    setQueueMsg,
                    {},
                    completeServiceItemsAction,
                    "Completed service on",
                  )
                }
                title="Mark service finished and record these devices as back on hand"
              >
                {completePending ? "Completing…" : "Complete service"}
              </button>
              {/* See the audit message above: a failure announces as an alert. */}
              {queueMsg && (
                <span role={queueMsg.ok ? "status" : "alert"} className={queueMsg.ok ? "subtle" : "alert-error"}>{queueMsg.text}</span>
              )}
            </div>
          )}

          {/* Sheet-only (hidden above 720px by globals.css), and it is also what
              gives the sheet its bottom padding and safe-area inset. A thumb has
              no Escape key and no obvious outside to tap; a mouse and keyboard
              have both. `popovertargetaction` means this costs no handler and no
              state. */}
          <div className="popup-menu__footer">
            <button
              type="button"
              className="btn btn-secondary"
              popoverTarget={menuId}
              popoverTargetAction="hide"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
