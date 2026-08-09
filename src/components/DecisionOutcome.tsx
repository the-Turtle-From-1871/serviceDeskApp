import { Check, X } from "lucide-react";
import type { Capability, Decision } from "@prisma/client";
import { CAPABILITY_LABELS } from "@/modules/users/capabilities";

export type OutcomeLine = { capability: Capability; decision: Decision };

/**
 * The per-capability outcome of a decided request. Rendered identically on
 * /account and in the admin queue's "Recently decided" list, so both sides read
 * the same thing.
 *
 * THE ICON IS NEVER THE ONLY SIGNAL. Each row carries the word "Approved" or
 * "Denied", the icon is aria-hidden, and colour is decorative — red/green alone
 * fails colour-blind users and says nothing at all to a screen reader.
 *
 * The denial reason renders ONCE, under the group, because one reason covers
 * everything withheld — mirroring the single justification on the request side.
 */
export function DecisionOutcome({
  items,
  denialReason,
}: {
  items: OutcomeLine[];
  denialReason?: string | null;
}) {
  const anyDenied = items.some((i) => i.decision === "DENIED");

  return (
    <div className="stack-sm">
      <ul className="decision-outcome">
        {items.map((i) => {
          const approved = i.decision === "APPROVED";
          const Icon = approved ? Check : X;
          return (
            <li key={i.capability} className={approved ? "is-approved" : "is-denied"}>
              <Icon className="decision-outcome__icon" aria-hidden="true" />
              <span className="decision-outcome__label">{CAPABILITY_LABELS[i.capability]}</span>
              <span className="decision-outcome__word">{approved ? "Approved" : "Denied"}</span>
            </li>
          );
        })}
      </ul>
      {anyDenied && denialReason && (
        <p className="decision-outcome__reason">
          <strong>Reason given:</strong> {denialReason}
        </p>
      )}
    </div>
  );
}
