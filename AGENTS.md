<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- Everything above is a tool-managed block and is regenerated on upgrade — put project
     notes BELOW this line, or they will be silently overwritten. -->

## Start with these four guides

`node_modules/next/dist/docs/` is 422 files. These are the ones whose Next 16 behavior most often
contradicts what a model already "knows", and the ones this app actually leans on:

- `01-app/01-getting-started/05-server-and-client-components.md` — the RSC/client boundary that
  decides where nearly every file in `src/app` can run.
- `01-app/01-getting-started/07-mutating-data.md` — Server Actions, which are this app's primary
  write path (`src/app/actions/*`, `src/app/admin/actions/*`).
- `01-app/01-getting-started/16-proxy.md` — **Next 16 renamed middleware to proxy.** This repo's
  `src/proxy.ts` is that file; it is not a custom abstraction, and searching for `middleware.ts`
  will find nothing.
- `01-app/01-getting-started/18-upgrading.md` — when something behaves unlike the Next you remember,
  check here before assuming the code is wrong.
