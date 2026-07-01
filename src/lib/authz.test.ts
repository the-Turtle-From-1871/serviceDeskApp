import { expect, test } from "vitest";
import { requireUser, requireAdmin, AuthError } from "./authz";

const admin = { id: "1", role: "ADMIN", name: "A", email: "a@x.co" } as const;
const user = { id: "2", role: "USER", name: "U", email: "u@x.co" } as const;

test("requireUser returns the user when a session exists", async () => {
  const getSession = async () => ({ user: user });
  await expect(requireUser(getSession)).resolves.toEqual(user);
});

test("requireUser throws UNAUTHENTICATED when no session", async () => {
  const getSession = async () => null;
  await expect(requireUser(getSession)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("requireAdmin throws FORBIDDEN for a standard user", async () => {
  const getSession = async () => ({ user: user });
  await expect(requireAdmin(getSession)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("requireAdmin returns the user for an admin", async () => {
  const getSession = async () => ({ user: admin });
  await expect(requireAdmin(getSession)).resolves.toEqual(admin);
});
