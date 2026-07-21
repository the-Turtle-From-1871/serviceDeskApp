"use client";
import { useState, useTransition } from "react";

// Generic on-demand signature reveal with a Show/Hide toggle. `load` fetches the
// signature image (a gated server action) only when first shown; the image is
// cached so hide/re-show is instant, no second round-trip. Used by the item-page
// audit history and the account page's saved signatures.
//
// The toggle button keeps the exact position the "Show signature" button had:
// pass `imageFirst` where the control is right-justified (the button trails the
// image, staying at the right edge); otherwise the button leads and the image
// reveals to its right. Either way, revealing the image never shifts the button.
export function SignatureReveal({
  load,
  alt,
  imageFirst = false,
}: {
  load: () => Promise<string | null>;
  alt: string;
  imageFirst?: boolean;
}) {
  const [image, setImage] = useState<string | null>(null); // cached once fetched
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  if (visible && image) {
    const img = (
      // eslint-disable-next-line @next/next/no-img-element
      <img key="img" src={image} alt={alt} className="sig-preview" />
    );
    const hide = (
      <button key="btn" type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible(false)}>
        Hide signature
      </button>
    );
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {imageFirst ? [img, hide] : [hide, img]}
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
