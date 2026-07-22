"use client";
import { useState, useTransition } from "react";

// Generic on-demand signature reveal with a Show/Hide toggle. `load` fetches the
// signature image (a gated server action) only when first shown; the image is
// cached so hide/re-show is instant, no second round-trip. Used by the item-page
// audit history and the account page's saved signatures.
//
// When revealed, the image stacks BELOW the toggle button (a column), never
// inline — so it can't widen the row into other controls or wrap the button to a
// new line. The button therefore keeps the exact spot the "Show signature" button
// had. `align` anchors the column: "end" for a right-justified control (audit
// column), "start" (default) for a left-anchored one (account list).
export function SignatureReveal({
  load,
  alt,
  align = "start",
}: {
  load: () => Promise<string | null>;
  alt: string;
  align?: "start" | "end";
}) {
  const [image, setImage] = useState<string | null>(null); // cached once fetched
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  if (visible && image) {
    return (
      <span
        style={{
          display: "inline-flex",
          flexDirection: "column",
          gap: 4,
          alignItems: align === "end" ? "flex-end" : "flex-start",
        }}
      >
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible(false)}>
          Hide signature
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt={alt} className="sig-preview" />
      </span>
    );
  }

  const show = () => {
    setFailed(false);
    if (image) {
      setVisible(true); // already fetched — reveal the cached image
      return;
    }
    start(async () => {
      try {
        const url = await load();
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
