import type { Capability } from "@prisma/client";
import { CAPABILITY_LABELS, CAPABILITIES, isRequestable } from "@/modules/users/capabilities";
import { DecisionOutcome } from "@/components/DecisionOutcome";
import { RequestPermissionsForm } from "./RequestPermissionsForm";

type RequestRow = {
  id: string;
  justification: string;
  status: "OPEN" | "CLOSED";
  denialReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: { name: string; rank: string | null } | null;
  items: { capability: Capability; decision: "PENDING" | "APPROVED" | "DENIED" }[];
};

const who = (p: { name: string; rank: string | null } | null) =>
  p ? `${p.rank ? `${p.rank} ` : ""}${p.name}` : "an administrator";

/**
 * "Your permissions" on /account: what you hold, what you have asked for, and
 * what came back.
 *
 * `held` is the RESOLVED effective set, so this cannot disagree with what the
 * server actually admits.
 */
export function PermissionsCard({
  held,
  requests,
}: {
  held: Capability[];
  requests: RequestRow[];
}) {
  const heldSet = new Set(held);
  // Everything requestable that they do not already hold. Computed here rather
  // than in the form so the offered list can never include something the
  // service would refuse.
  const available = CAPABILITIES.filter((c) => isRequestable(c) && !heldSet.has(c));

  const pending = requests.filter((r) => r.status === "OPEN");
  const decided = requests.filter((r) => r.status === "CLOSED");

  return (
    <div className="card stack">
      <div className="card__title">Your permissions</div>

      <div className="stack-sm">
        <p className="subtle" style={{ margin: 0 }}>What you can do today:</p>
        <ul style={{ margin: 0 }}>
          {held.map((c) => (
            <li key={c}>{CAPABILITY_LABELS[c]}</li>
          ))}
        </ul>
      </div>

      {pending.length > 0 && (
        <div className="stack-sm">
          <p className="label" style={{ margin: 0 }}>Waiting for a decision</p>
          {pending.map((r) => (
            <div key={r.id} className="stack-sm">
              <p className="subtle" style={{ margin: 0 }}>
                Asked on {r.createdAt.toLocaleDateString()} for{" "}
                {r.items.map((i) => CAPABILITY_LABELS[i.capability]).join(", ")}.
              </p>
              {/* Omitted entirely when blank — the justification is optional,
                  and a bare pair of quote marks reads as a rendering fault
                  rather than as "you did not write one". */}
              {r.justification && (
                <p style={{ margin: 0, fontStyle: "italic" }}>&ldquo;{r.justification}&rdquo;</p>
              )}
            </div>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <div className="stack-sm">
          <p className="label" style={{ margin: 0 }}>Recent decisions</p>
          {decided.map((r) => (
            <div key={r.id} className="stack-sm">
              <p className="subtle" style={{ margin: 0 }}>
                Requested {r.createdAt.toLocaleDateString()} — decided{" "}
                {r.decidedAt ? r.decidedAt.toLocaleDateString() : ""} by {who(r.decidedBy)}
              </p>
              <DecisionOutcome items={r.items} denialReason={r.denialReason} />
            </div>
          ))}
        </div>
      )}

      <div className="stack-sm">
        <p className="label" style={{ margin: 0 }}>Ask for more</p>
        <RequestPermissionsForm available={available} />
      </div>
    </div>
  );
}
