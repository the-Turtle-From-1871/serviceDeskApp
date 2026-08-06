import { deleteDraftAction } from "@/app/actions/drafts";

// A server component: there is no client state here. Delete is a plain form
// posting to a Server Action, deliberately NOT a confirmation `<dialog>` — a
// draft is low-stakes and recoverable by retyping, and this app has a
// documented trap where a layout class on a `<dialog>` defeats the UA's
// `dialog:not([open])` rule and renders every closed dialog.
//
// Mirrors SignatureManager's list shape (ul.stack-sm > li.row + .spacer) so the
// two cards on this page read the same. `.row` wraps, so on a phone the label
// and the two actions stack instead of colliding.
export function DraftList({ drafts }: {
  drafts: { id: string; label: string; updatedAt: Date }[];
}) {
  if (drafts.length === 0) {
    return <p className="subtle">No saved drafts. Use “Save draft” on a new hand receipt to keep one here.</p>;
  }
  return (
    <ul className="stack-sm">
      {drafts.map((d) => (
        <li key={d.id} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <strong>{d.label}</strong>
            <div className="subtle" style={{ fontSize: 12 }}>
              Saved {d.updatedAt.toLocaleString()}
            </div>
          </div>
          <span className="spacer" />
          <a
            className="btn btn-secondary btn-sm"
            style={{ minHeight: "var(--tap)" }}
            href={`/receipts/new?draft=${d.id}`}
          >
            Resume
          </a>
          <form action={deleteDraftAction}>
            <input type="hidden" name="id" value={d.id} />
            <button
              type="submit"
              className="btn btn-ghost btn-sm"
              style={{ minHeight: "var(--tap)" }}
              aria-label={`Delete draft ${d.label}`}
            >
              Delete
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
