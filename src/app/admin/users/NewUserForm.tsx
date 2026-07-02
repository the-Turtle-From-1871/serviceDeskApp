"use client";
import { useActionState } from "react";
import { createUserAction } from "@/app/admin/actions/users";
import { RANK_OPTIONS } from "@/lib/ranks";

export function NewUserForm() {
  const [state, action, pending] = useActionState(createUserAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="nu-rank">Rank</label>
          <input id="nu-rank" className="input" name="rank" list="nu-ranks" placeholder="e.g. SGT (optional)" autoComplete="off" />
          <datalist id="nu-ranks">
            {RANK_OPTIONS.map((r) => <option key={r} value={r} />)}
          </datalist>
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-name">Name</label>
          <input id="nu-name" className="input" name="name" placeholder="Jane Doe" required />
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-email">Email</label>
          <input id="nu-email" className="input" name="email" type="email" placeholder="jane@unit.mil" required />
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-unit">Unit</label>
          <input id="nu-unit" className="input" name="unit" placeholder="e.g. A Co, 1-1 IN (optional)" />
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-contact">Contact number</label>
          <input id="nu-contact" className="input" name="contactNumber" placeholder="(optional)" />
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-pw">Temporary password</label>
          <input id="nu-pw" className="input" name="password" type="password" placeholder="8+ characters" required />
        </div>
        <div className="field">
          <label className="label" htmlFor="nu-role">Role</label>
          <select id="nu-role" className="select" name="role" defaultValue="USER">
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
      </div>
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Adding…" : "Add user"}
        </button>
        {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
        {state && "ok" in state && state.ok && <span className="alert-success">User created.</span>}
      </div>
    </form>
  );
}
