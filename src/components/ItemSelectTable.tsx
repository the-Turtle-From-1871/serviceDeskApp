"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS } from "@/modules/transfers/receipt-lines";

export type ItemRow = { id: string; make: string; model: string; serialNumber: string; status: "ACTIVE" | "RETIRED" };

export function ItemSelectTable({ items, isAdmin }: { items: ItemRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const groupCount = useMemo(() => {
    const keys = new Set<string>();
    for (const it of items) if (selected.has(it.id)) keys.add(`${it.make} ${it.model}`);
    return keys.size;
  }, [selected, items]);
  const tooMany = groupCount > MAX_RECEIPT_ROWS;

  const create = () => { if (selected.size && !tooMany) router.push(`/receipts/new?items=${[...selected].join(",")}`); };

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th></th><th>Make</th><th>Model</th><th>Serial</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} aria-label={`Select ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
                <td data-label="Make">{it.make}</td>
                <td data-label="Model">{it.model}</td>
                <td className="mono" data-label="Serial">{it.serialNumber}</td>
                <td data-label="Status"><StatusBadge status={it.status} /></td>
                <td data-label="">
                  <div className="actions" style={{ justifyContent: "flex-end" }}>
                    <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
                    {isAdmin && <Link href={`/admin/items/${it.id}/qr`} className="btn btn-ghost btn-sm">QR</Link>}
                    {isAdmin && <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>}
                    {isAdmin && (
                      <form action={toggleItemStatusAction}>
                        <input type="hidden" name="id" value={it.id} />
                        <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
                        <button type="submit" className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}>{it.status === "RETIRED" ? "Reactivate" : "Retire"}</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected.size > 0 && (
        <div className="card row" style={{ position: "sticky", bottom: 0, justifyContent: "space-between" }}>
          <span>{selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}</span>
          {tooMany
            ? <span role="alert" className="alert-error">Too many item types ({groupCount}). Max {MAX_RECEIPT_ROWS} per receipt — split into two.</span>
            : <button className="btn btn-primary" onClick={create}>Create receipt from {selected.size} selected</button>}
        </div>
      )}
    </>
  );
}
