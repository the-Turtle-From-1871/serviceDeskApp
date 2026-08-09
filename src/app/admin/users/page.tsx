import { redirect } from "next/navigation";
import { ChevronDown } from "lucide-react";
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

      {/* Collapsed by default: this page is about users, and the contact book
          is the half nobody comes here for — receipts file their non-DCSIM
          parties into it automatically (upsertContactFromParty), so hand-adding
          a contact is the exception.

          A native <details>, mirroring UnitManager's "Devices with no home
          unit" block: it opens before hydration, takes Enter/Space on the
          <summary> for free, and needs no state. It also needs no
          marker-suppression rule — preflight is absent so <summary> keeps the
          UA's `display: list-item`, but `.btn` sets `display: inline-flex`,
          which overrides it and takes the triangle with it.

          `stack-sm`, not `card stack-sm` as UnitManager uses: ContactBookSection
          renders its own .card around the add-form, and an outer one would nest
          a card inside a card.

          The <h2> is INSIDE the summary so the page keeps its outline; see
          `.disclosure-title` in globals.css for why it needs its own rule.

          Note this collapses the section VISUALLY only — a closed <details>
          still renders its contents, so the whole book ships to the client on
          every load exactly as before. */}
      <details className="stack-sm">
        <summary className="btn btn-secondary">
          <h2 className="disclosure-title">Contact book ({contacts.length})</h2>
          <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
        </summary>
        <p className="subtle">Saved recipients, ordered by last name.</p>
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
      </details>
    </div>
  );
}
