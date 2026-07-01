// NOTE: Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`
// (the `middleware` export is renamed to `proxy`). Proxy always runs on the
// Node.js runtime in Next 16 -- the `runtime` option cannot be configured and
// edge is not supported here -- so `@/auth`'s Credentials provider (which
// transitively imports `@/lib/prisma` -> the `pg` driver adapter, a Node-only
// module) bundles cleanly with no edge-runtime split needed.
// See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
export { auth as proxy } from "@/auth";

export const config = {
  // Protect everything except auth API, login, public item pages, static assets.
  matcher: ["/((?!api/auth|login|i/|_next/static|_next/image|favicon.ico).*)"],
};
