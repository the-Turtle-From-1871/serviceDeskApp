import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Terms of Service — Hand Receipt" };

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Terms of Service</h1>
          <p className="subtle">Last updated: July 10, 2026</p>
        </div>

        <div className="card legal">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of the DCSIM Service
            Desk hand receipt application (the &ldquo;Service&rdquo;). By accessing or using the Service, you
            agree to these Terms.
          </p>

          <h2>Authorized use</h2>
          <p>
            The Service is provided for official equipment-accountability purposes by authorized personnel
            only. You must have a valid account and use the Service consistent with applicable regulations and
            your organization&rsquo;s policies.
          </p>

          <h2>Your account</h2>
          <p>
            You are responsible for maintaining the confidentiality of your login credentials and for all
            activity under your account. Provide accurate information and keep it current. Notify an
            administrator immediately of any unauthorized use.
          </p>

          <h2>Acceptable use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>access data or accounts that you are not authorized to access;</li>
            <li>enter false, misleading, or fraudulent hand receipt information;</li>
            <li>attempt to disrupt, probe, or circumvent the security of the Service;</li>
            <li>use the Service for any unlawful purpose or in violation of applicable policy.</li>
          </ul>

          <h2>Hand receipts and records</h2>
          <p>
            Hand receipts and related entries created in the Service are intended to document custody and
            accountability of equipment. You are responsible for the accuracy of the information you enter and
            for following your organization&rsquo;s property-accountability procedures. Signatures captured in
            the Service are your acknowledgment of the associated transaction.
          </p>

          <h2>Availability</h2>
          <p>
            The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We do not
            guarantee that it will be uninterrupted, error-free, or that data will never be lost. Maintenance,
            updates, or outages may occur.
          </p>

          <h2>Disclaimer of warranties</h2>
          <p>
            To the maximum extent permitted by law, the Service is provided without warranties of any kind,
            whether express or implied, including fitness for a particular purpose.
          </p>

          <h2>Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, the operators of the Service will not be liable for any
            indirect, incidental, or consequential damages arising from your use of, or inability to use, the
            Service.
          </p>

          <h2>Changes to these Terms</h2>
          <p>
            We may modify these Terms from time to time. Continued use of the Service after changes take effect
            constitutes acceptance of the revised Terms. The &ldquo;Last updated&rdquo; date above reflects the
            latest version.
          </p>

          <h2>Contact</h2>
          <p>Questions about these Terms can be directed to the DCSIM Service Desk.</p>
        </div>
      </main>
    </>
  );
}
