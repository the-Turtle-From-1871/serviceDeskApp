import { expect, test } from "vitest";
import { requireUser, requireAdmin, requireCapability, AuthError, type SessionUser } from "./authz";
import { roleBaseline } from "@/modules/users/capabilities";

// `capabilities` is the RESOLVED effective set, exactly as defaultGetSession
// builds it — these fixtures go through roleBaseline so they cannot drift from
// the real mapping.
const admin = {
  id: "1", role: "ADMIN", name: "A", email: "a@x.co",
  capabilities: roleBaseline("ADMIN"),
} as const;

const user = {
  id: "2", role: "USER", name: "U", email: "u@x.co",
  capabilities: roleBaseline("USER"),
} as const;

const viewer = {
  id: "3", role: "VIEWER", name: "V", email: "v@x.co",
  capabilities: roleBaseline("VIEWER"),
} as const;

// A USER who was GRANTED one extra capability. The point of the whole model:
// their role is unchanged, but the grant admits them.
// Annotated rather than `as const`: the annotation contextually types the inline
// array, so a capability name that does not exist is a compile error here.
const grantedUser: SessionUser = {
  id: "4", role: "USER", name: "G", email: "g@x.co",
  capabilities: [...roleBaseline("USER"), "PROCESS_RETURNS"],
};

test("requireUser returns the user when a session exists", async () => {
  const getSession = async () => ({ user });
  await expect(requireUser(getSession)).resolves.toEqual(user);
});

test("requireUser throws UNAUTHENTICATED when no session", async () => {
  const getSession = async () => null;
  await expect(requireUser(getSession)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("requireAdmin throws FORBIDDEN for a standard user", async () => {
  const getSession = async () => ({ user });
  await expect(requireAdmin(getSession)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("requireAdmin returns the user for an admin", async () => {
  const getSession = async () => ({ user: admin });
  await expect(requireAdmin(getSession)).resolves.toEqual(admin);
});

test("requireCapability admits a user holding it via their role baseline", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("CREATE_RECEIPTS", getSession)).resolves.toEqual(user);
});

test("requireCapability admits a user holding it via a grant", async () => {
  const getSession = async () => ({ user: grantedUser });
  await expect(requireCapability("PROCESS_RETURNS", getSession)).resolves.toEqual(grantedUser);
});

test("requireCapability refuses a user who holds neither", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("MANAGE_ITEMS", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("requireCapability refuses a VIEWER everything but reading inventory", async () => {
  const getSession = async () => ({ user: viewer });
  await expect(requireCapability("VIEW_INVENTORY", getSession)).resolves.toEqual(viewer);
  await expect(requireCapability("CREATE_RECEIPTS", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(requireCapability("EDIT_ITEM_HOLDER", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("requireCapability throws UNAUTHENTICATED before FORBIDDEN when there is no session", async () => {
  const getSession = async () => null;
  await expect(requireCapability("VIEW_INVENTORY", getSession)).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
});

// The hinge of the migration: a granted ADMINISTER must satisfy every existing
// requireAdmin() call site without any of them being edited.
test("a granted ADMINISTER satisfies requireAdmin without a role change", async () => {
  const grantedAdmin: SessionUser = {
    id: "5", role: "USER", name: "P", email: "p@x.co",
    capabilities: [...roleBaseline("USER"), "ADMINISTER"],
  };
  const getSession = async () => ({ user: grantedAdmin });
  await expect(requireAdmin(getSession)).resolves.toEqual(grantedAdmin);
});

test("AuthError is thrown, not a bare Error", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("ADMINISTER", getSession)).rejects.toBeInstanceOf(AuthError);
});
