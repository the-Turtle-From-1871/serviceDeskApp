import { redirect } from "next/navigation";
import { listUsers } from "@/modules/users/users.service";
import { toggleUserActiveAction } from "@/app/admin/actions/users";
import { requireAdmin, AuthError } from "@/lib/authz";
import { NewUserForm } from "./NewUserForm";

export default async function UsersPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const users = await listUsers();
  return (
    <div>
      <h1>Users</h1>
      <NewUserForm />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.isActive ? "Yes" : "No"}</td>
              <td>
                <form action={toggleUserActiveAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="active" value={(!u.isActive).toString()} />
                  <button type="submit">{u.isActive ? "Deactivate" : "Activate"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
