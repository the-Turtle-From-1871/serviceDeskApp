# DCSIM Hand Receipt System

**Executive Summary for G6 Leadership — Hawaii Army National Guard**

**Prepared:** 5 August 2026 · **Status:** Live and in daily use

**Points of contact**
Application maintainer — SPC Xiaolan Lin, DCSIM Service Desk IT Specialist · xiaolan.lin.mil@army.mil
Developer — CDT Joshua Yang, DCSIM Intern · bubbayajo21@gmail.com

---

## Bottom line up front

- **We now have a signed, searchable custody record for IT equipment.** Every device issued produces a digital DA Form 2062 with the recipient's signature captured on screen, retrievable by anyone holding the receipt number or the QR code on the device.
- **Every person who signs for equipment is emailed their own copy, automatically.** The moment a device is issued, the individual who signed receives the completed DA Form 2062 as a PDF attachment — the same message copying the service desk and the `army.mil` records mailbox. No technician has to remember to send it, and the recipient never has to come back and ask us for proof of what they signed for. The same happens when equipment is returned and when a device is ready for pickup.
- **The system forces verification.** A device counts as accounted for only when a technician has physically laid hands on it and recorded it — there is no shortcut to mark it accounted for without that check. The accountability figure leadership sees is therefore one the desk can stand behind.
- **An independent security review completed today found no critical and no high-severity issues, and no unauthorized-access flaws.** Five items were confirmed in total: three medium, two low. The highest-priority item was corrected the same day.
- **The property book maintains itself nightly.** A scheduled job pulls the device management export straight into the system, so the catalog stays current without anyone driving it by hand.

---

## What the system does

| Capability | What it replaces |
|---|---|
| Issues a signed DA Form 2062 with an on-screen signature; PDF generated instantly | Filling and typing the form by hand, chasing a wet signature, scanning and filing |
| Emails the receipt with the signed PDF attached to the recipient, copying the service desk and the `army.mil` records mailbox | Separate messages, hand-delivered copies, and a records copy that depended on somebody remembering |
| Tracks partial and full returns against the original receipt, with the accepting technician signing for each | The same return tracking done by hand on paper copies — now a digital record that is instantly searchable instead of filed away |
| Looks a device up by serial number, receipt number, QR label, or the name of the person holding it | Searching a spreadsheet or a paper file |
| Runs the repair/reimage service queue per device, with optional deadlines and automatic overdue alerts | Tracking bench work on a whiteboard or in someone's head |
| Records annual physical audits per device, with the auditing technician's signature | A separate inventory binder with no link to the issue record |
| Maintains a live fleet dashboard — readiness, audit posture, device counts by unit | A report someone assembles by hand when asked |

Supporting detail that matters operationally:

- **A receipt is a signed document, not a live view.** Serial numbers, both parties' details and the signature are frozen onto the receipt when it is created. Correcting a device record later does not silently rewrite a document somebody already signed.
- **Each receipt is cryptographically sealed at creation.** An administrator can re-check any receipt and the system reports whether it has been altered since it was signed.
- **Fleet status is calculated, not maintained.** "Deployed", "In repair", "Ready to deploy" and "Retired" are worked out from live evidence — an open unreturned receipt, a service flag, a device-management logon, or a technician marking a device back on the shelf. There is no status field for anyone to keep up to date, so the picture cannot quietly go stale.
- **Closed receipts are permanently purged 90 days after they close**, automatically. Deactivated accounts are purged after three months, except where deleting one would break a record it authored.
- **Everything displays in Hawaii Standard Time.**

---

## Operational impact

### Accountability of government property
- Custody now attaches to a **signature**, tied to a specific serial number, with a permanent record of who processed it and when.
- **Every change to a device record is logged** — what field changed, from what to what, and who changed it. So is every bulk import.
- The system distinguishes **three different questions** that used to be conflated: *do we physically have it* (proven by an audit), *is it issued out* (proven by an open receipt), and *is it serviceable* (from the repair queue). Leadership can now ask each one separately.
- Deleting a device record does **not** erase the receipts it appears on. A signed document outlives the equipment record it describes.

### Audit readiness
- Devices are on an **annual audit cycle**. The dashboard buckets the whole fleet into audited within the year / audit overdue / never audited, and the same figure drives the badge on every device page — the dashboard and the device list cannot disagree.
- **Current audit posture, honestly stated:** as of 30 July 2026, **31 devices out of a fleet of roughly 1,200** carried a recorded audit — about **2.6%**. This is not a defect in the tool; it is the true starting position.
- **Arithmetic on those sourced figures:** sustaining an annual cycle across ~1,200 devices requires roughly **100 audits per month**, indefinitely. That is the resourcing question this brief most wants leadership to see.

### Custody documentation
- **The recipient is emailed their signed receipt at the moment of issue**, with the completed DA Form 2062 attached as a PDF. This is automatic and unconditional — it is not a step a technician can forget, and it does not depend on anyone remembering to forward a copy.
- **The same message copies the service desk and an `army.mil` archive mailbox**, on **every** receipt, return and pickup notice. One message, one distribution, one record — rather than a customer copy, a desk copy and a records copy that each depended on somebody sending them.
- A recipient does not need an account, a login, or our help to retrieve what they signed for later. The emailed link and the QR code printed on the receipt open that receipt directly, including its PDF.
- The practical effect: **a soldier can always produce what they signed for**, and the desk can always produce it for them, without either side searching a shared drive or a filing cabinet.

### Service turnaround for soldiers waiting on gear
- A device flagged for repair or reimage carries its own queue entry with type, note, and an optional deadline. **A blank deadline means no deadline** — the system will not invent one and then report work as overdue that nobody dated.
- A nightly sweep emails **one** alert per lapsed deadline, for both overdue equipment returns and overdue bench work. The admin dashboard lists what is overdue and what is due within three days.
- Completing bench work automatically marks the device back on hand, so it appears as ready to reissue without a second data-entry step.

---

## Efficiency and technician time savings

**Sourced facts** (verifiable in the system's own records):

- The nightly device-management import **replaces a person opening the import page and running it by hand**, and it now runs unattended every night rather than whenever someone got to it.
- An import handles up to **2,000 device rows in a single run**; a full 2,000-row refresh was **measured at roughly 0.8 seconds** against a local database. Import time is not a constraint.
- Bulk actions operate on a whole selection at once — marking devices on hand, setting a category, printing QR labels (**about 72 labels per page, 8 across**). Correcting a unit's name **rewrites every device assigned to it** in one action.
- QR labels resolve a physical device to its record by scanning it, with no lookup step.

**Estimates — the arithmetic is shown so the assumptions can be challenged, not the conclusion:**

- **Receipt production — ESTIMATE.** *Assumption (unmeasured): a hand receipt done manually — filling the form, obtaining a signature, scanning, filing, emailing a copy — takes about 12 minutes; the same receipt in the system takes about 3.* If the desk issues **10 receipts a week**: 10 × 9 min = **90 minutes a week, roughly 6 hours a month**. Both the per-receipt minutes and the weekly volume are assumptions. Replace them with the desk's own timings before quoting this figure upward.
- **Property book maintenance — ESTIMATE.** *Assumption (unmeasured): a manual fleet import ran weekly and took about 10 minutes of a technician's attention* (upload, review, resolve unrecognized units, confirm). Automating it returns roughly **40 minutes a month** — and, more importantly, changes the catalog from weekly to nightly currency.
- *Where the hours actually come back.* The recurring savings are in the **repetitive** work: generating and distributing the form, keeping the catalog current, finding a device, and chasing overdue returns. The system does **not** save time on the audit campaign itself — physically laying hands on 1,200 devices is unchanged. It only makes the count trustworthy.

---

## Current status

- **Live in production on its own domain (`www.dcsim.us`)**, updated continuously. The application moved off its original hosting address after that address was found to be blocked on the government network; QR labels printed before 4 August 2026 still carry the old address and are worth reprinting eventually, though the application's own scanner reads them correctly and any device can still be found by searching its serial number.
- **Built and shipped over 37 days** (30 June – 5 August 2026), from first working version to current state.
- **Recent additions (last two weeks):**
  - Emailed and printed receipt links now open the recipient's receipt directly, without an access code prompt — scoped to that one receipt only.
  - All outbound receipt, return and pickup notices are now a **single message to the customer** copying the record addresses, rather than several unconnected copies.
  - **Delivery to `army.mil` addresses is fixed and confirmed end to end.** The long-standing silent drops were caused by the old hosting address appearing in the message body, not by any authentication failure. A hand receipt with its PDF has since been delivered to an `army.mil` inbox.
  - Devices can be searched by **who is holding them**, not just by serial or model.
  - Rank is no longer required on a receipt — the property book holds civilians, contractors and outside-agency staff, and technicians were inventing a rank to get past the form.
  - The public front page now explains what the application is to anyone who opens it.
- **Known operational chore:** the outbound mail credential currently expires every 7 days and must be renewed. Tooling automates the renewal and warns before it lapses, but it remains a standing task — the desk is removing it permanently, see *Operational next steps*.

---

## Risk posture and stewardship

An **independent security review was completed today** (5 August 2026) across the entire codebase — all 506 tracked files, every administrative page, every action that changes data, and every externally reachable address.

- **No critical and no high-severity issues.** Five items were confirmed in total: **three medium and two low**.
- **No unauthorized-access flaws.** Every one of the system's 49 data-changing operations and all 10 administrative pages — plus every machine-to-machine connection — check the user's role and account status **against the database on every single request**, so a demotion or a deactivation takes effect immediately rather than whenever a session happens to expire.
- **The highest-priority item was corrected the same day.** Changing your password did not previously end sessions already open elsewhere — the exact thing you do when you suspect someone else is in your account. It now signs you out everywhere, immediately, on every device. Two automated tests were added so it cannot regress.
- **The four remaining items are availability and robustness concerns, not access concerns.** Two medium: a receipt PDF could fail to generate if a party's name contains a character the official form's built-in font cannot print (ordinary Hawaiian and Vietnamese names would do it), and an oversized signature image is accepted without a sanity check on its size. Two low: one page does more database work than it needs to, and the sign-in page takes measurably longer to reject a real account than a made-up one, which could let someone confirm whether an address has an account. All four have documented fixes and **none exposes data to anyone who should not see it.**
- **Sixteen risks are formally accepted and documented, not overlooked** — each recorded with what it exposes and what would force us to revisit it. A further 21 candidate issues were examined and cleared.

### On the public receipt and device pages — this is intentional

- **Recipients who are not system users can view the receipt they signed and the device page behind a QR label.** This is a deliberate, documented decision: the whole point is that a soldier who signed for a laptop can retrieve that document without an account.
- Those pages sit behind a **shared 8-digit access code** for anyone not signed in, which expires after 12 hours, plus limits that refuse automated scraping. Emailed and printed receipt links carry a token good for **that one receipt only** — it does not open anything else.
- The review confirmed this arrangement **works as designed** and that the receipt-specific token withstood every attack constructed against it. Do not treat the public pages as a finding; they are a requirement that was reviewed and accepted.

### What the review actually concluded

- The controls that exist are **implemented correctly**, the access model has **no known holes**, and the team's own record of accepted risks is **accurate** — that last point matters, because it means the risk register can be trusted as a management tool rather than needing to be re-derived.
- The review's headline concern was **documentation drift** — a small number of places where the security documentation described protection more confidently than the software actually delivered. Those have been corrected. This matters because those documents are exactly what somebody relies on while responding to an incident, when there is no time to go and check.
- Scope, methodology and the limits of what a review of this kind can establish are recorded in the technical handover document, where they belong.

---

## Where this goes next

Near-term priorities:

1. **Prevent the same device being issued twice.** Today the system will let a technician build a second receipt for a device that is already out on an open, unreturned one. It is not silent — the device list, the device page and the fleet dashboard all show the device as deployed and name who holds it, and the builder displays a note when the person named as issuing the device is not the person recorded as holding it. But nothing refuses the receipt, and no note appears at all if those two names happen to match. Turning that into a positive check — *this device is already signed out to someone* — closes the most likely route to two people being signed for one device at once.
2. **Sub-hand-receipt capability.** The system records one issue, from the desk to a holder. It cannot yet represent equipment signed further down the chain — a hand receipt holder issuing to their own soldiers — because a receipt has no concept of being derived from another. This is the capability required for accountability to reach past the first level of issue, and it is the largest single gap between what the system does today and how property accountability works in the formation.
3. **Deeper accountability reporting.** Record *who* performed each privileged action — retiring a device, closing a ticket, changing an account. Today most of those record the change but not the person, so "who retired this device" cannot be answered from the record. There is also no log of sign-ins, failed sign-ins or access-code entries.
4. **Continued search and lookup improvements**, building on the recent addition of holder-name search.

---

## Operational next steps — owned by the service desk

These are housekeeping actions the desk is taking on its own authority. They are listed for visibility, not for decision:

1. **Provisioning an individual account for every technician.** Accountability for "who processed this return" and "who recorded this audit" depends on each person having their own login; a shared credential silently erases it. The desk is standing up individual accounts and retiring any shared use.
2. **Working the audit campaign.** Sustaining the annual cycle across ~1,200 devices is roughly 100 physical audits a month. The desk is scheduling this into routine work. The system cannot generate the count — it can only report it truthfully, which it now does, and that reporting is what will show progress against the ~2.6% starting position.
3. **Rotating the shared access code to a randomly generated value and controlling its distribution.** The security review noted the system will accept any eight digits, while the protection it provides assumes the code was chosen at random. The desk is regenerating it properly and tightening who holds it.
4. **Moving outbound mail onto a permanent footing.** Receipt, return and overdue email currently depends on a credential that expires every 7 days and is renewed by hand — a chore that, if missed, stops all outbound receipt email with no bounce to warn anyone. The desk is pursuing the permanent fix (either formally publishing the application's sign-in consent screen, or moving the sending mailbox to a managed account on the `dcsim.us` domain) to remove the weekly task entirely.
5. **Closing out the security review's remaining items** — the four open findings above, plus the documentation and record-keeping improvements it recommended.

---

### A note on the figures in this brief

Every number above is either **verifiable in the system's own records and documentation** — fleet and audit counts, the 90-day retention window, the annual audit cycle, the access-code policy, the security review's finding counts, the measured import timing, the label sheet, and the development window — or is **explicitly labeled an ESTIMATE with its assumption and arithmetic shown**. Two figures are derived arithmetic on sourced numbers and are marked as such: the 2.6% audited share, and the ~100 audits a month an annual cycle requires. The two time-savings estimates rest on unmeasured inputs; replace them with the desk's own timings before briefing them as fact. Nothing here is an invented adoption, cost, or hours-saved figure.
