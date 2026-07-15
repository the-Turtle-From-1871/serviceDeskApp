"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

export type PickableSignature = { id: string; name: string; image: string };

// Technician signing control. The admin picks WHICH technician signed from their
// saved named signatures, or draws an ad-hoc one (attributed to their own
// account name server-side).
//
// A saved pick posts only `signatureId` — never the name or the image. The
// server re-reads both from the DB scoped to the acting admin, so a client
// cannot forge a signer name, inject an image, or use another admin's
// signature. The image here is preview-only.
export function TechnicianSignatureField({
  name, signatures, onChange,
}: { name: string; signatures: PickableSignature[]; onChange?: (value: string) => void }) {
  const [selectedId, setSelectedId] = useState(signatures[0]?.id ?? "");
  const [drawn, setDrawn] = useState("");
  const picked = signatures.find((s) => s.id === selectedId);
  // Reported upward only so the parent can gate submit; not what gets posted.
  const value = picked ? picked.image : drawn;

  useEffect(() => { onChange?.(value); }, [value, onChange]);

  return (
    <div className="stack-sm">
      {signatures.length > 0 && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Who signed?</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 180 }}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="">Draw a new one…</option>
          </select>
        </label>
      )}

      {picked ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picked.image} alt={`Signature for ${picked.name}`} className="sig-preview" />
          <input type="hidden" name="signatureId" value={picked.id} />
        </>
      ) : (
        <>
          <SignaturePad onChange={setDrawn} />
          <p className="subtle">This will be recorded under your own name.</p>
          <input type="hidden" name={name} value={drawn} />
        </>
      )}
    </div>
  );
}
