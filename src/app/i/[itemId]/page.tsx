import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getItem } from "@/modules/items/items.service";
import { ItemDetails } from "@/components/ItemDetails";

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const session = await auth();
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto" }}>
      <h1>{item.make} {item.model}</h1>
      <ItemDetails item={item} />
      <section id="history">
        <h2>Transfer history</h2>
        <p>Transfer history appears here.</p>
      </section>
      {!session?.user && <p><Link href="/login">Sign in</Link> to transfer or sign for this item.</p>}
      {/* Holder actions (Initiate transfer) added in Plan 3. */}
    </main>
  );
}
