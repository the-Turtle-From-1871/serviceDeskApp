import { HomeSearch } from "@/components/HomeSearch";
import { SiteHeader } from "@/components/SiteHeader";

export default async function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Find an item or hand receipt</h1>
          <p className="subtle">Search by item serial number, or look up a hand receipt by its number (HR-XXXXXX).</p>
        </div>
        <HomeSearch />
      </main>
    </>
  );
}
