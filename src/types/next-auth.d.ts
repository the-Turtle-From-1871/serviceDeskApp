import type { Role } from "@prisma/client";
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: Role; name: string; email: string };
  }
  interface User {
    id: string;
    role: Role;
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    pwdChangedAt?: number | null;
    /** Epoch ms of sign-in. Never moved — the 10-hour absolute bound. */
    authAt?: number | null;
    /** Epoch ms of the last request on this session — the 4-hour idle clock. */
    lastActiveAt?: number | null;
  }
}
