import type { Metadata } from "next";
import Link from "next/link";
import { HomeSearch } from "@/components/HomeSearch";
import { SiteHeader } from "@/components/SiteHeader";
import { publicAccessAllowed } from "@/lib/public-access-guard";

// The home page is the app's public description of itself, so the title and
// description are written for someone who has never seen it — a recipient
// following a QR code, or a reviewer checking what this application is for.
export const metadata: Metadata = {
  title: "DCSIM Hand Receipt — digital equipment hand receipts",
  description:
    "The DCSIM service desk's hand receipt system: issue IT equipment on signed digital DA Form 2062 hand receipts, look up a device by serial number, and download a receipt as a PDF.",
};

export default async function HomePage() {
  // This page is reachable by anyone; the item and receipt DATA behind it is
  // not. `publicAccessAllowed()` is the same check the search action enforces
  // for itself — here it only decides whether to render the search box or the
  // way in. See src/lib/public-access-guard.ts.
  const unlocked = await publicAccessAllowed();

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">DCSIM Hand Receipt</h1>
          <p className="subtle">
            Digital hand receipts and equipment accountability for the DCSIM service desk. Issue IT
            equipment to a recipient on a signed hand receipt, track who is holding it, and return
            it — without paper.
          </p>
        </div>

        {unlocked ? (
          <>
            <div>
              <h2 className="page-title">Find an item or hand receipt</h2>
              <p className="subtle">
                Search by item serial number, or look up a hand receipt by its number (HR-XXXXXX).
              </p>
            </div>
            <HomeSearch />
          </>
        ) : (
          <div className="card stack">
            <div>
              <h2 className="card__title">Looking up your equipment or hand receipt?</h2>
              <p className="subtle">
                Item and hand receipt records are protected by a shared access PIN. Enter the
                8-digit PIN to search by serial number or receipt number. If you do not have the
                PIN, ask the service desk.
              </p>
            </div>
            <div className="row">
              <Link className="btn btn-primary" href="/unlock?next=%2F">
                Enter access PIN
              </Link>
              <Link className="btn btn-secondary" href="/login">
                Log in
              </Link>
              <Link className="btn btn-ghost" href="/register">
                Create account
              </Link>
            </div>
          </div>
        )}

        {/* Rendered for everyone, unlocked or not: this is the page that says
            what the application is, and that should not depend on who is
            looking. */}
        <div className="card legal">
          <h2>What this application does</h2>
          <ul>
            <li>
              <strong>Issues equipment on a digital hand receipt.</strong> A technician builds a DA
              Form 2062-style hand receipt for one or more devices, the recipient signs it on
              screen, and both parties get a numbered receipt (HR-000000) that can be downloaded as
              a PDF.
            </li>
            <li>
              <strong>Tracks custody.</strong> Every device in the property book shows who is
              currently holding it, which hand receipt put it there, and its full transfer history.
            </li>
            <li>
              <strong>Processes returns.</strong> When equipment comes back, the service desk closes
              the receipt and the device returns to inventory.
            </li>
            <li>
              <strong>Looks up a device by serial number.</strong> Each item has its own page and QR
              code, so a recipient can scan a device and read its record without an account.
            </li>
            <li>
              <strong>Runs the service queue.</strong> Devices flagged for repair or reimage are
              tracked through to completion, with deadlines and readiness state.
            </li>
            <li>
              <strong>Sends transactional email.</strong> The service desk mailbox notifies the
              parties to a hand receipt — a new receipt, a completed return, or equipment ready for
              pickup. No marketing or bulk email is sent.
            </li>
          </ul>

          <h2>Who it is for</h2>
          <p>
            The service desk technicians who issue and recover equipment, and the people who receive
            it. Anyone can <Link href="/register">create an account</Link>: you confirm your email
            address, and the account can then look up equipment and see the hand receipts you are
            named on. Issuing receipts, editing items and processing returns are separate
            permissions, granted by an administrator. Recipients who just need to read a receipt or
            an item record need only the access PIN, with no account at all.
          </p>

          <h2>Your information</h2>
          <p>
            Hand receipts contain the names, units, and contact details of the issuing and receiving
            parties, the recipient&rsquo;s signature, and the equipment issued. How that information
            is collected, used, and retained is described in our{" "}
            <Link href="/privacy">Privacy Policy</Link>; use of the application is governed by our{" "}
            <Link href="/terms">Terms of Service</Link>.
          </p>
        </div>
      </main>
    </>
  );
}
