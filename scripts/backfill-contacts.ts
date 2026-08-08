import "dotenv/config";

import { backfillContactsFromReceipts } from "../src/modules/contacts/backfill";

// Operator-run one-off: seed the contact book from parties already on existing
// hand receipts. See src/modules/contacts/backfill.ts for the rules.
//
//   npm run backfill:contacts           # preview, writes nothing
//   npm run backfill:contacts -- --apply
//
// Dry run is the DEFAULT and `--apply` is required to write. This points at
// whatever DATABASE_URL is in the environment — which, run against production,
// is a bulk write to a shared table with no undo. Making the harmless mode the
// one you get by forgetting a flag is the whole reason for the inversion.

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const url = process.env.DATABASE_URL ?? "";
  // Naming the target is not decoration: the difference between the local dev
  // DB and Supabase is one env var, and this writes to whichever it finds.
  const target = url.replace(/\/\/[^@]*@/, "//<redacted>@") || "(DATABASE_URL unset)";
  console.log(`[backfill-contacts] ${dryRun ? "DRY RUN — nothing will be written" : "APPLYING"}`);
  console.log(`[backfill-contacts] database: ${target}`);

  const r = await backfillContactsFromReceipts({ dryRun });

  const created = dryRun ? "would create " : "created      ";
  const refreshed = dryRun ? "would refresh" : "refreshed    ";
  console.log(`  receipts scanned : ${r.receiptsScanned}`);
  console.log(`  party slots seen : ${r.partiesSeen} (non-DCSIM, with an email)`);
  console.log(`  distinct people  : ${r.distinctPeople}`);
  console.log(`  ${created}    : ${r.created}`);
  console.log(`  ${refreshed}    : ${r.updated}`);
  console.log(`  skipped          : ${r.skipped} (name could not be split into first + last)`);

  if (dryRun) console.log("\nRe-run with --apply to write these changes.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[backfill-contacts] failed:", e);
    process.exit(1);
  });
