# Hand Receipt: 4-Day Development Sprint

## Instructions for Claude (Agent Protocol)
When instructed to execute a specific Day, follow these rules strictly:

1. **Sequential & Parallel Planning:** Work through the unchecked `- [ ]` tasks for that Day. If two tasks are independent, you may spawn sub-agents or parallel worktrees (`claude -w`) to execute them simultaneously.
2. **Clarification Threshold:** If a task involves ambiguous business logic, UX/layout choices not specified in the prompt, or destructive schema changes, **PAUSE and ask the user a clarifying question** before proceeding.
3. **Execution & Sub-Agent Self-Review:** 
   - Write the code for the task.
   - Spin up a **Code Review Sub-Agent** to inspect your `git diff`. The sub-agent must audit for edge cases, missing types, security flaws, and Next.js App Router best practices.
   - Address any issues flagged by the reviewer sub-agent.
4. **Verification:** Run `npm run build` or relevant tests to verify zero compilation or runtime errors.
5. **Autonomy Loop:** If a build/test error occurs, attempt to fix it autonomously. If you fail 3 times on the same bug, pause and ask the user for help.
6. **recommendations:** if you have recommendations regarding tweaks to the implementation, raise them.
7. **Commit & Check:** Once verified, commit the changes to git with a descriptive message, physically check the box by changing `- [ ]` to `- [x]` in this `SPRINT.md` file, and immediately proceed to the next task.
---

## Day 1: Foundation & Data
- [x] **CI/CD Pipeline:** Create a GitHub Actions workflow in `.github/workflows/ci.yml`. It must install dependencies, run a standard Semgrep SAST scan, and verify the Next.js app compiles with `npm run build`.
- [x] **Baseline SAST Scan:** Run `/plugin install claude-security@claude-plugins-official` (if not installed) and execute `/claude-security scan codebase`. Ensure the codebase is clean before writing new features.
- [x] **Prisma Schema Update:** Update `prisma/schema.prisma` to track operational readiness. 
    - Add an `isAccountedFor` boolean (default `true`) to the `items` model.
    - Add a `deployableStatus` enum with states: `DEPLOYED`, `READY_TO_DEPLOY`, `IN_REPAIR`, and `RETIRED`. Add this field to the `items` model.
    - Generate the migration, apply it locally, and ensure TypeScript types update.

## Day 2: The UI & Frontend Heavy-Lifting
- [x] **Analytics Dashboard Route:** Build a single-view dashboard at a new route using `shadcn/ui` and `lucide-react` in a CSS Grid (Global filters on top, charts in the middle, unit distribution at the bottom).
    - **Global UIC Filter:** Add a `shadcn/ui` Select dropdown at the top of the page to filter by `deviceUIC`. It must default to "All Units". When a specific UIC is selected, ALL widgets on the page must dynamically re-fetch and filter their data for that exact unit.
    - **Widget 1 (Audit Readiness):** Recharts donut chart showing `isAccountedFor` true vs false.
    - **Widget 2 (Fleet KPIs):** KPI cards showing the current count of items "In Service" (`DEPLOYED`) side-by-side with items "Ready" (`READY_TO_DEPLOY`), grouped by device category.
    - **Widget 3 (Fleet Status Over Time):** Recharts stacked area chart tracking the four `deployableStatus` states over time.
    - **Widget 4 (DA Form 2062 Velocity):** Recharts stacked bar chart counting completed transfers per month, stacked by item category.
    - **Widget 5 (Unit Allocation Leaderboard):** A scrollable `shadcn/ui` Table/List card showing each `deviceUIC` and the total quantity of items assigned to it (broken down by Total, Deployed, and Ready). Clicking a unit in this list should update the Global UIC Filter.
    - **Chart Interactive Features:** Add a `shadcn/ui` ToggleGroup to the time-series charts for 30d, 90d, 6m, 1y views. Add a dropdown menu to all charts using `html-to-image` to export a PNG, and a CSV export for the raw JSON data.
- [x] **Sorting, Grouping, & Bulk Actions:** Update the main inventory table. Group items by `deployableStatus` by default. Add a new table column for `deviceUIC` and allow filtering by it. Implement compound sorting (e.g., Manufacturer then Serial Number). Add a bulk-action checkbox feature allowing admins to update the `deployableStatus` or `isAccountedFor` status for multiple items simultaneously.

## Day 3: Security & Auth Hardening
- [x] **Robust Rate Limiting & Botnet Defense:** Implement advanced rate limiting using Vercel KV (Redis) and Next.js middleware:
    - Use composite keys (`IP + Target Email`) for auth routes to prevent shared base network lockouts (Max 5 failed attempts per rolling 15-min window).
    - Implement global velocity tracking in Redis to detect sudden application-wide spikes in failed logins (indicating a distributed botnet).
    - Set general API scraping limits to 100 requests per minute per IP, and drop requests with suspicious or missing browser headers/User-Agents.
- [x] **CAPTCHA Integration:** Integrate Cloudflare Turnstile into the authentication flow. Add the invisible widget to the login and `/forgot-password` pages to block automated headless scripts. Enforce token verification server-side in Next.js Server Actions.
- [x] **Session Freshness:** Update the Auth.js configuration and middleware to enforce a strict 10-hour workday lifecycle. Set absolute token expiration (`maxAge`) to 10 hours. Implement an idle timeout in middleware that forces re-authentication if the user's last activity was more than 4 hours ago.


## Day 4: Final Polish & Documentation
- [x] **Final SAST Scan:** Run a final `/claude-security scan codebase` to verify the new UI, Auth, and Rate Limiting features did not introduce any vulnerabilities. Create a
  - *Done 2026-08-05.* Full multi-agent scan of all 506 tracked files at revision `ff4857f`: 5 verified findings (0 critical, 0 high, 3 medium, 2 low), 16 accepted risks adjudicated, 21 candidates cleared. The top finding (self-service password change did not revoke live sessions) was fixed the same day in `f0e8838`. Note this task's own sentence is truncated in the original sprint plan — "Create a " has no object — so only the scan half could be executed as written.
- [x] **Security Handover Report:** Read the git history, Next.js API routes, Auth.js config, and SAST results. Generate a formal `SECURITY_REPORT.md` documenting: 1) Executive Summary, 2) Auth & Access Control logic, 3) Threat Mitigation (Rate Limiting/Turnstile specifics), and 4) Vulnerability Assessment.
  - *Done 2026-08-05 as `SECURITY_ASSESSMENT.md`*, not `SECURITY_REPORT.md`. All four required parts are present (executive summary §1; access control §5; injection/anti-abuse §6–7; findings §3–4), plus an accepted-risk register, a reconciliation against `docs/SECURITY.md`, and an explicit coverage-and-limitations section.
- [x] **Global Documentation Sync:** Scan the entire repository for ALL existing Markdown files (including `README.md`, any files in a `docs/` folder, and root-level guides, but ignoring `agents.md`). Read them and update any outdated sections regarding the database schema, features, tech stack, or authentication to accurately reflect the Vercel KV, Turnstile, and analytics changes made during this sprint. Backdate the CHANGELOG.md to the start.
  - *Done 2026-08-04 (`04521ad`), and run a second time 2026-08-05* against the drift the security assessment surfaced. `docs/superpowers/` and `.superpowers/sdd/` are deliberately excluded from both passes: they are dated design records, not descriptions of today's app.
- [x] **Handoff & Changelog:** Read the full git history. Generate a `CHANGELOG.md` backdated to the repository's start, adhering to existing guardrails. Finally, generate a comprehensive `HANDOFF.md` document detailing the complete, updated architecture and operational state for leadership review. Include the problem and solution that our web app fixes.
  - *Done.* `CHANGELOG.md` was backdated to 2026-06-30 in `04521ad`. The handoff shipped 2026-08-05 as **two** documents rather than one `HANDOFF.md`, because the single file was serving two audiences that need opposite things: `HANDOVER.md` (technical successor — architecture, invariants, a 20-item backlog) and `LEADERSHIP_BRIEF.md` (non-technical, for G6 leadership — mission impact and efficiency, no code jargon).