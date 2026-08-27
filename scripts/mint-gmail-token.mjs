/**
 * Mint a Gmail `gmail.send` refresh token and write it into .env.local.
 *
 * Replaces the OAuth half of scripts/gmail-token-rotation/, whose delivery half
 * pushed the token to Vercel and redeployed — dead weight since Vercel was
 * retired (2026-08-21). This writes the local env file instead, which is where
 * `getEmailSender()` actually reads from now.
 *
 * Flow: PKCE S256 + loopback redirect on http://127.0.0.1:<port>, matching what
 * a Desktop-app OAuth client accepts. `access_type=offline` is what asks for a
 * refresh token at all; `prompt=consent` is what makes Google re-issue one even
 * when a grant already exists (a silent re-auth returns none, so there would be
 * nothing to save).
 *
 * Usage:  node scripts/mint-gmail-token.mjs
 * Reads GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from .env.local so no secret has
 * to be typed on a command line.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import dotenv from "dotenv";

const ENV_FILE = ".env.local";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

const die = (m) => { console.error(`\n[mint-gmail-token] ${m}\n`); process.exit(1); };

if (!fs.existsSync(ENV_FILE)) die(`${ENV_FILE} not found.`);
const env = dotenv.parse(fs.readFileSync(ENV_FILE));
const clientId = (env.GMAIL_CLIENT_ID || "").trim();
const clientSecret = (env.GMAIL_CLIENT_SECRET || "").trim();
if (!clientId || !clientSecret) {
  die(`Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in ${ENV_FILE} first (uncomment them if they are commented out).`);
}

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const server = createServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
  code_challenge: challenge, code_challenge_method: "S256", state,
  access_type: "offline", prompt: "consent",
});

console.log("");
console.log("=".repeat(70));
console.log("Open this URL and approve as the GMAIL_FROM account:");
console.log("=".repeat(70));
console.log(authUrl);
console.log("=".repeat(70));
console.log("");
// The URL MUST be quoted for cmd: an OAuth URL is full of "&", which cmd reads as a
// command separator, so an unquoted URL arrives truncated at the first parameter.
// Google then rejects it with "Required parameter is missing: response_type", which
// reads like a malformed request rather than a broken way of opening it.
// windowsVerbatimArguments stops Node re-escaping the quotes we add here.
try {
  spawn(process.env.COMSPEC || "cmd", ["/c", `start "" "${authUrl}"`],
    { stdio: "ignore", detached: true, windowsVerbatimArguments: true }).unref();
} catch { /* the printed URL above is the fallback */ }

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out after 5 minutes waiting for approval")), 300_000);
  server.on("request", (req, res) => {
    const u = new URL(req.url, redirectUri);
    const got = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem">
      <h2>${got ? "Authorized — you can close this tab." : "Authorization failed: " + (err || "no code")}</h2></body>`);
    clearTimeout(timer);
    if (got) resolve(got);
    else reject(new Error(err || "no code in redirect"));
  });
});
server.close();

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code,
    code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok) die(`token exchange failed (HTTP ${tokenRes.status}): ${tok.error} ${tok.error_description || ""}`);
if (!tok.refresh_token) die("Google returned no refresh_token. That happens on a silent re-auth; this script sends prompt=consent, so re-check the client is a Desktop app type.");
if (!String(tok.scope || "").includes(SCOPE)) die(`granted scope is missing ${SCOPE} (got: ${tok.scope})`);

let s = fs.readFileSync(ENV_FILE, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const line = `GMAIL_REFRESH_TOKEN=${tok.refresh_token}`;
s = /^#?\s*GMAIL_REFRESH_TOKEN=.*$/m.test(s)
  ? s.replace(/^#?\s*GMAIL_REFRESH_TOKEN=.*$/m, line)
  : s + (s.endsWith(nl) ? "" : nl) + line + nl;
fs.writeFileSync(ENV_FILE, s);

console.log(`Wrote GMAIL_REFRESH_TOKEN to ${ENV_FILE}. Scope: ${tok.scope}`);
console.log("Restart the dev server for it to take effect.");
