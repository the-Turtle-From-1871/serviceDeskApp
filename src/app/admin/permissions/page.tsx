import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listOpenRequests, listRecentlyDecided } from "@/modules/users/permissions.service";
import { DecisionOutcome } from "@/components/DecisionOutcome";
import { DecisionForm } from "./DecisionForm";

export const dynamic = "force-dynamic";

const who = (p: { name: string; rank: string | null } | null) =>
  p ? `${p.rank ? `${p.rank} ` : ""}${p.name}` : "an administrator";

export default async function PermissionsQueuePage() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const [open, decided] = await Promise.all([listOpenRequests(), listRecentlyDecided()]);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Permission requests</h1>
        <p className="subtle">
          Everything starts ticked except <em>Grant Administrator</em>, which makes the person an
          administrator outright. Untick anything you are not granting and say why — the requester
          sees your reason.
        </p>
      </div>

      {open.length === 0 ? (
        <div className="card">
          <p className="subtle" style={{ margin: 0 }}>Nothing waiting for a decision.</p>
        </div>
      ) : (
        open.map((r) => (
          <div key={r.id} className="card stack">
            <div>
              <div className="card__title">{who(r.user)}</div>
              <p className="subtle" style={{ margin: 0 }}>
                {r.user.email} · asked {r.createdAt.toLocaleDateString()}
              </p>
            </div>
            {/* The justification is optional, so this can be blank. Say so
                explicitly rather than rendering empty quotes: the admin is
                about to decide, and "they gave no reason" is information they
                should be able to act on — including by denying and asking for
                one. */}
            {r.justification ? (
              <p style={{ margin: 0, fontStyle: "italic" }}>&ldquo;{r.justification}&rdquo;</p>
            ) : (
              <p className="subtle" style={{ margin: 0 }}>No reason given.</p>
            )}
            <DecisionForm
              requestId={r.id}
              capabilities={r.items.map((i) => i.capability)}
              // The server refuses this regardless; showing it here means the
              // refusal is visible before submitting rather than after.
              selfRequest={r.userId === admin.id}
            />
          </div>
        ))
      )}

      {decided.length > 0 && (
        <>
          <div>
            <h2 className="page-title">Recently decided</h2>
            <p className="subtle">The same outcome the requester sees.</p>
          </div>
          {decided.map((r) => (
            <div key={r.id} className="card stack-sm">
              <div className="card__title">{who(r.user)}</div>
              <p className="subtle" style={{ margin: 0 }}>
                decided {r.decidedAt ? r.decidedAt.toLocaleDateString() : ""} by {who(r.decidedBy)}
              </p>
              <DecisionOutcome items={r.items} denialReason={r.denialReason} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
