/**
 * Scheduled trigger for the nightly maintenance sweep.
 *
 * Replaces .github/workflows/purge-cron.yml, which has been firing into the void
 * since 2026-08-21: it curls https://www.dcsim.us/api/cron/purge, and that host
 * still resolves (to Vercel) but answers 503 because the deployment is gone.
 * GitHub's runners cannot reach this app any more — it is a local dev server on
 * a tailnet — so the trigger has to live on the same machine as the app.
 *
 * The sweep is NOT only a purge, which matters when reading its log line: it also
 * sends the overdue-transfer and overdue-service alert emails. Those stopped
 * going out at the same time and for the same reason.
 *
 * Same shape as mail-import-task.mjs, and for the same reasons: CRON_SECRET is
 * read from .env.local at run time rather than sitting in the Task Scheduler UI
 * and its XML export, and a dev server that simply is not running logs SKIP
 * rather than FAIL, so the log stays worth reading.
 *
 * Usage: node scripts/purge-task.mjs [--url http://localhost:3000]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argUrl = process.argv.indexOf("--url");
const base = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3000";

const logFile = path.join(root, "logs", "purge.log");
function log(line) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()}  ${line}\n`);
  console.log(line);
}

function env(key) {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const value = dotenv.parse(fs.readFileSync(p))[key];
    if (value) return value;
  }
  return undefined;
}

const secret = env("CRON_SECRET");
if (!secret) {
  log("SKIP  CRON_SECRET is not set — the route fails closed and would refuse this anyway.");
  process.exit(0);
}

const url = `${base.replace(/\/$/, "")}/api/cron/purge`;
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(120_000),
  });
} catch (e) {
  log(`SKIP  could not reach ${url} (${e.name === "TimeoutError" ? "timed out" : "server not running"})`);
  process.exit(0);
}

let body;
try {
  body = await res.json();
} catch {
  log(`FAIL  HTTP ${res.status} with a non-JSON body`);
  process.exit(1);
}
if (!res.ok) {
  log(`FAIL  HTTP ${res.status}  ${body.error ?? "(no message)"}`);
  process.exit(1);
}

// Logged in full every run, including the all-zero case. A purge that deletes
// nothing is the NORMAL outcome on most nights, and the value of the line is
// proving the sweep ran at all — which is exactly what nobody could tell for the
// week this was silently dead.
log(
  `OK    receipts purged ${body.transfers?.deletedCount ?? 0}, ` +
    `accounts deleted ${body.users?.deletedCount ?? 0} (skipped ${body.users?.skippedCount ?? 0}), ` +
    `drafts purged ${body.drafts?.deletedCount ?? 0}, ` +
    `alerts sent: overdue receipts ${body.alerts?.overdueTransfers ?? 0}, overdue service ${body.alerts?.overdueService ?? 0}`,
);
