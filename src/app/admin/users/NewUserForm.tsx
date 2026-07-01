"use client";
import { useActionState } from "react";
import { createUserAction } from "@/app/admin/actions/users";

export function NewUserForm() {
  const [state, action, pending] = useActionState(createUserAction, undefined);
  return (
    <form action={action} style={{ marginBottom: 24 }}>
      <input name="name" placeholder="Name" required />
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Temp password (8+)" required />
      <select name="role"><option value="USER">User</option><option value="ADMIN">Admin</option></select>
      <button disabled={pending} type="submit">Add user</button>
      {state?.error && <span role="alert" style={{ color: "crimson" }}> {state.error}</span>}
      {state && "ok" in state && state.ok && <span> Created.</span>}
    </form>
  );
}
