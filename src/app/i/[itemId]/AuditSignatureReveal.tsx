"use client";
import { useState, useTransition } from "react";
import { revealAuditSignatureAction } from "@/app/actions/audit";

// The item-page audit history hides each auditor's signature by default (the
// blob isn't even shipped — see getAuditsForItem). This button fetches one
// signature on demand and swaps it in. Any signed-in staff member may reveal it;
// the action re-checks with requireUser. Mirrors the receipt "Verify seal"
// reveal, and keeps this client boundary off the server-rendered page.
export function AuditSignatureReveal({ auditId, signerName }: { auditId: string; signerName: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt={`Signature of ${signerName}`} className="sig-preview" />;
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          setFailed(false);
          try {
            const url = await revealAuditSignatureAction(auditId);
            if (url) setImage(url);
            else setFailed(true);
          } catch {
            setFailed(true);
          }
        })
      }
    >
      {pending ? "Loading…" : failed ? "Couldn't load — retry" : "Show signature"}
    </button>
  );
}
