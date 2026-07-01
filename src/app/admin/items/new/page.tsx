"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["assetTag", "Asset tag", false],
  ["homeLocation", "Home location", false],
  ["notes", "Notes", false],
] as const;

export default function NewItemPage() {
  const [state, action, pending] = useActionState(createItemAction, undefined);
  if (state && "itemId" in state && state.itemId) {
    return (
      <div>
        <h1>Item created</h1>
        <p><Link href={`/admin/items/${state.itemId}/qr`}>View / print QR code →</Link></p>
        <p><Link href="/admin/items/new">Add another</Link></p>
      </div>
    );
  }
  return (
    <div>
      <h1>New item</h1>
      <form action={action}>
        {fields.map(([name, label, req]) => (
          <label key={name} style={{ display: "block", marginBottom: 8 }}>
            {label}{req ? " *" : ""}
            <input name={name} required={req} style={{ width: "100%" }} />
          </label>
        ))}
        {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
        <button disabled={pending} type="submit">{pending ? "Saving…" : "Create item"}</button>
      </form>
    </div>
  );
}
