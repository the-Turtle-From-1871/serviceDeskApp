import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Privacy Policy — Hand Receipt" };

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Privacy Policy</h1>
          <p className="subtle">Last updated: July 10, 2026</p>
        </div>

        <div className="card legal">
          <p>
            This Privacy Policy explains how the DCSIM Service Desk hand receipt application (the
            &ldquo;Service&rdquo;) collects, uses, and protects information. By using the Service you agree to
            the practices described here.
          </p>

          <h2>Information we collect</h2>
          <ul>
            <li>
              <strong>Account information</strong> — your name, email address, rank (where applicable), and
              role, used to authenticate you and control access.
            </li>
            <li>
              <strong>Hand receipt data</strong> — information entered to create and manage hand receipts,
              including the names, ranks, units, contact numbers, and email addresses of the sending and
              receiving parties; equipment details (make, model, serial number, device name); quantities; and
              the recipient&rsquo;s signature.
            </li>
            <li>
              <strong>Usage and technical data</strong> — records needed to operate the Service, such as
              timestamps and audit entries of actions taken.
            </li>
          </ul>

          <h2>How we use information</h2>
          <ul>
            <li>To create, display, and manage digital hand receipts and track custody of equipment.</li>
            <li>
              To generate PDF hand receipts and send transactional email notifications (for example, a new
              hand receipt, a completed return, or an &ldquo;items ready for pickup&rdquo; notice).
            </li>
            <li>To authenticate users, enforce access controls, and maintain an audit trail.</li>
          </ul>

          <h2>Email delivery</h2>
          <p>
            Transactional emails are delivered through a third-party email provider (such as Google/Gmail or
            Resend). The content of those emails — hand receipt details and links — is transmitted to that
            provider solely to deliver the message.
          </p>

          <h2>How we share information</h2>
          <p>
            We do not sell personal information. Information is shared only as necessary to operate the
            Service — for example, with the email delivery provider above and the hosting and database
            infrastructure that runs the application. We may disclose information where required by law or by
            applicable government policy.
          </p>

          <h2>Data retention</h2>
          <p>
            Hand receipt records and audit entries are retained as long as needed to maintain equipment
            accountability and to meet record-keeping requirements. Account information is retained while your
            account is active.
          </p>

          <h2>Security</h2>
          <p>
            Access to the Service requires authentication, and access controls limit users to the data
            appropriate to their role. No system can guarantee absolute security; please protect your
            credentials and notify an administrator of any suspected compromise.
          </p>

          <h2>Your choices</h2>
          <p>
            You may request corrections to your account information by contacting an administrator. Because
            hand receipts are accountability records, they may not be deletable on request.
          </p>

          <h2>Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. Material changes will be reflected by updating
            the &ldquo;Last updated&rdquo; date above.
          </p>

          <h2>Contact</h2>
          <p>Questions about this policy can be directed to the DCSIM Service Desk.</p>
        </div>
      </main>
    </>
  );
}
