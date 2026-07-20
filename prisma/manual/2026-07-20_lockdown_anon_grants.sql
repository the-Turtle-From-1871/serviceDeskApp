-- Item 1.2 — defense-in-depth for the Supabase Data API (PROD / Supabase ONLY).
--
-- The app reaches Postgres ONLY through Prisma on a privileged role — never via
-- the Supabase Data API (PostgREST) as anon/authenticated. Supabase grants those
-- roles FULL CRUD on every public table by default, so although RLS is currently
-- "enabled, no policy" (deny-all), if RLS were ever disabled on a table the live
-- anon key could read/write it. Strip those grants and the anon-executable
-- rls_auto_enable helper so the anon key cannot touch data even if RLS is toggled.
--
-- Safe for the app (it does not use anon/authenticated). REVOKE is idempotent.
-- The local Docker dev DB has no anon/authenticated roles, so this is prod-only.
-- Applied to prod 2026-07-20 via the Supabase MCP.
--
-- Belt-and-suspenders you can also do in the dashboard: disable the Data API
-- entirely (Settings → API) and/or rotate-disable the legacy anon key, since this
-- app never uses PostgREST.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
