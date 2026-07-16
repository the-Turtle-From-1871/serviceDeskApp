import { redirect } from "next/navigation";
import { listUsers } from "@/modules/users/users.service";
import { toggleUserActiveAction, setUserRoleAction } from "@/app/admin/actions/users";
import { requireAdmin, AuthError } from "@/lib/authz";
import { NewUserForm } from "./NewUserForm";
import { listContacts } from "@/modules/contacts/contacts.service";
import { ContactBookSection } from "./ContactBookSection";

export default async function UsersPage() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  const [users, contacts] = await Promise.all([listUsers(), listContacts()]);
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Users</h1>
        <p className="subtle">Create accounts and manage roles and access.</p>
      </div>

      <div className="card">
        <div className="card__title">Add a user</div>
        <NewUserForm />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Active</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === admin.id;
              return (
                <tr key={u.id}>
                  <td data-label="Name">{u.rank ? `${u.rank} ` : ""}{u.name}{isSelf && <span className="subtle"> (you)</span>}</td>
                  <td className="mono" data-label="Email">{u.email}</td>
                  <td data-label="Role">
                    <span className={`badge ${u.role === "ADMIN" ? "badge-admin" : "badge-retired"}`}>
                      {u.role === "ADMIN" ? "Admin" : "User"}
                    </span>
                  </td>
                  <td data-label="Active">
                    <span className={`badge ${u.isActive ? "badge-active" : "badge-cancelled"}`}>
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td data-label="">
                    <div className="actions actions--end">
                      <form action={setUserRoleAction}>
                        <input type="hidden" name="id" value={u.id} />
                        <input type="hidden" name="role" value={u.role === "ADMIN" ? "USER" : "ADMIN"} />
                        <button type="submit" className="btn btn-ghost btn-sm" disabled={isSelf}>
                          {u.role === "ADMIN" ? "Make user" : "Make admin"}
                        </button>
                      </form>
                      <form action={toggleUserActiveAction}>
                        <input type="hidden" name="id" value={u.id} />
                        <input type="hidden" name="active" value={(!u.isActive).toString()} />
                        <button
                          type="submit"
                          className={`btn btn-sm ${u.isActive ? "btn-danger" : "btn-secondary"}`}
                          disabled={isSelf && u.isActive}
                        >
                          {u.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="page-title">Contact book</h2>
        <p className="subtle">Saved recipients, ordered by last name.</p>
      </div>
      <ContactBookSection
        contacts={contacts.map((c) => ({
          id: c.id,
          rank: c.rank,
          firstName: c.firstName,
          lastName: c.lastName,
          unit: c.unit,
          contactNumber: c.contactNumber,
          email: c.email,
        }))}
      />
    </div>
  );
}
