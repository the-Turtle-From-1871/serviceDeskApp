import Link from "next/link";
import { listItems } from "@/modules/items/items.service";

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const items = await listItems({ search: q });
  return (
    <div>
      <h1>Items</h1>
      <form>
        <input name="q" defaultValue={q ?? ""} placeholder="Search make/model/serial/tag" />
        <button>Search</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Make</th>
            <th>Model</th>
            <th>Serial</th>
            <th>Holder</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.make}</td>
              <td>{it.model}</td>
              <td>{it.serialNumber}</td>
              <td>{it.currentHolder?.name ?? "—"}</td>
              <td>{it.status}</td>
              <td>
                <Link href={`/i/${it.id}`}>View</Link>
                {" · "}
                <Link href={`/admin/items/${it.id}/qr`}>QR</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
