"use client";
import { useState, useTransition } from "react";
import { revealAuditSignatureAction } from "@/app/actions/audit";

// The item-page audit history hides each auditor's signature by default (the
// blob isn't even shipped — see getAuditsForItem). "Show signature" fetches one
// on demand and reveals it; "Hide signature" tucks it away again. The fetched
// image is kept in state, so hiding then re-showing is instant (no second
// round-trip). Any signed-in staff member may reveal it; the action re-checks
// with requireUser. Kept a client component to keep this boundary off the page.
export function AuditSignatureReveal({ auditId, signerName }: { auditId: string; signerName: string }) {
  const [image, setImage] = useState<string | null>(null); // cached once fetched
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  if (visible && image) {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt={`Signature of ${signerName}`} className="sig-preview" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible(false)}>
          Hide signature
        </button>
      </span>
    );
  }

  const show = () => {
    setFailed(false);
    if (image) {
      setVisible(true); // already fetched — just reveal the cached image
      return;
    }
    start(async () => {
      try {
        const url = await revealAuditSignatureAction(auditId);
        if (url) {
          setImage(url);
          setVisible(true);
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={show}>
      {pending ? "Loading…" : failed ? "Couldn't load — retry" : "Show signature"}
    </button>
  );
}
