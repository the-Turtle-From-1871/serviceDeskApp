/**
 * Scheduled trigger for the emailed MDM import.
 *
 * Run by a Windows Scheduled Task. It exists rather than putting a curl command
 * in the task definition for one reason: CRON_SECRET would otherwise sit in
 * plaintext in the Task Scheduler UI, in its XML export, and in the Windows
 * event log. Here it is read from .env.local at run time and never printed.
 *
 * Every run appends one line to logs/mail-import.log. An unattended job with no
 * log is an unattended job nobody can debug — including the ordinary case where
 * the dev server simply is not running, which must read as "skipped", not as a
 * failure worth chasing.
 *
 * Usage: node scripts/mail-import-task.mjs [--url http://localhost:3000]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argUrl = process.argv.indexOf("--url");
const base = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3000";

const logDir = path.join(root, "logs");
const logFile = path.join(logDir, "mail-import.log");
function log(line) {
  fs.mkdirSync(logDir, { recursive: true });
  // ISO first so the file sorts chronologically and greps cleanly by date.
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
  log("SKIP  CRON_SECRET is not set — the route would refuse this anyway (it fails closed).");
  process.exit(0);
}

const url = `${base.replace(/\/$/, "")}/api/cron/import-mail`;
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    // Generous: the route itself is bounded by maxDuration, and a slow import
    // is not a reason for the CLIENT to give up and look like a failure.
    signal: AbortSignal.timeout(120_000),
  });
} catch (e) {
  // By far the most common line in this log: the dev server is not running.
  // Deliberately not an error — the machine is simply off or idle, and the next
  // run picks the export up. Anything louder would train you to ignore the log.
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
  // 502 is a refusal the service produced deliberately (bad sender, no
  // attachment, not a CSV) and its message is written to be read here.
  log(`FAIL  HTTP ${res.status}  ${body.error ?? "(no message)"}`);
  process.exit(1);
}

const { status } = body;
if (status === "disabled") log("SKIP  MAIL_IMPORT_SENDERS/SUBJECT not configured");
else if (status === "none") log("OK    no new export");
else if (status === "unchanged") log(`OK    unchanged (superseded ${body.superseded})`);
else {
  log(
    `OK    imported from ${body.from}: added ${body.added}, updated ${body.updated}, ` +
      `unchanged ${body.unchanged}, skipped ${body.skipped?.length ?? 0}, superseded ${body.superseded}`,
  );
}
