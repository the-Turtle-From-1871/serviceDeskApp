// Run the dev server against the Supabase database. This is what `npm run dev`
// does; `npm run dev:local` is the local Docker Postgres.
//
// Why a wrapper rather than editing .env: prisma.config.ts resolves the
// migration engine's URL from `DIRECT_URL ?? DATABASE_URL` loaded out of .env,
// so putting a Supabase URL there would silently aim `npm run db:migrate` and
// `npm run db:reset` (migrate reset --force) at production. Here the override
// exists only inside the spawned `next dev` process and dies with it — the
// Prisma CLI, the test suite and a plain `npm run dev` all still see the local
// Docker Postgres.
//
// Next does not overwrite variables already present in process.env, so passing
// DATABASE_URL through the child environment beats the value in .env.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const ENV_FILE = ".env.supabase";

function die(msg) {
  console.error(`\n[dev:supabase] ${msg}\n`);
  process.exit(1);
}

if (!existsSync(ENV_FILE)) {
  die(`${ENV_FILE} not found. It holds the Supabase connection string and is gitignored, so each clone creates its own.`);
}

const parsed = dotenv.parse(readFileSync(ENV_FILE));
const url = (parsed.DATABASE_URL ?? "").trim();

if (!url) {
  die(`DATABASE_URL is empty in ${ENV_FILE}. Paste the Session pooler string from Supabase Dashboard -> Project Settings -> Database -> Connection string.`);
}
// Catch the two mistakes that would make this command a lie: a local URL (you
// think you are on prod and are not) and a missing sslmode (Supabase refuses
// the connection, which surfaces as an opaque connect error at first login).
if (/localhost|127\.0\.0\.1/.test(url)) {
  die(`DATABASE_URL in ${ENV_FILE} points at localhost, not Supabase. Use \`npm run dev\` for the local database.`);
}
if (!/sslmode=/.test(url)) {
  die(`DATABASE_URL in ${ENV_FILE} has no sslmode. Append ?uselibpqcompat=true&sslmode=require.`);
}
// A BARE sslmode=require is the trap this check exists for: node-postgres treats
// 'require' as an alias for 'verify-full', Supabase's pooler chain fails that,
// and Prisma raises P1011 TlsConnectionError. The dev server still boots and
// still says "Ready", so the failure only appears as every DB-backed page
// erroring - which reads as an app bug rather than a connection-string typo.
if (/sslmode=require/.test(url) && !/uselibpqcompat=true/.test(url)) {
  die(`DATABASE_URL in ${ENV_FILE} uses a bare sslmode=require, which node-postgres treats as verify-full and Supabase's certificate chain fails (P1011 TlsConnectionError). Use ?uselibpqcompat=true&sslmode=require, or sslmode=no-verify.`);
}

const host = (() => {
  try { return new URL(url).host; } catch { return "(unparseable host)"; }
})();

console.log(`
+--------------------------------------------------------------+
|  SUPABASE - THE LIVE DATABASE, AND THE ONLY COPY              |
|  This dev server reads and writes REAL custody data.          |
|  Every edit, delete and receipt is permanent. No undo.        |
+--------------------------------------------------------------+
  host: ${host}
`);

const child = spawn(
  process.execPath,
  [new URL("./copy-wasm.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  { stdio: "inherit" },
);
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  // Resolve Next's own bin and run it on this Node, rather than shelling out to
  // npx: `shell: true` on Windows concatenates argv instead of escaping it
  // (Node DEP0190) and would mangle any argument containing a space.
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const next = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  next.on("exit", (c) => process.exit(c ?? 0));
});
