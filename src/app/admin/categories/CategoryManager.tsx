"use client";
import { useActionState } from "react";
import { createCategoryAction, deleteCategoryAction } from "@/app/admin/actions/categories";
import type { CategoryRow } from "@/modules/items/categories.service";

type ActionState = { ok?: boolean; message?: string; error?: string } | undefined;

export function CategoryManager({ categories }: { categories: CategoryRow[] }) {
  const [addState, addAction, adding] = useActionState<ActionState, FormData>(
    createCategoryAction,
    undefined,
  );
  const [removeState, removeAction, removing] = useActionState<ActionState, FormData>(
    deleteCategoryAction,
    undefined,
  );

  return (
    <div className="stack">
      <section className="card stack-sm">
        <h2>Add a category</h2>
        <p className="subtle">
          Categories group devices on the readiness dashboard and filter the items table. A CSV
          import that carries a new category adds it here automatically.
        </p>
        <form action={addAction} className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <label className="stack" style={{ gap: 4, flex: "1 1 220px" }}>
            <span className="label" id="new-category-label">Category name</span>
            <input
              className="input"
              name="name"
              required
              maxLength={60}
              placeholder="e.g. Laptops"
              aria-labelledby="new-category-label"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding}>
            {adding ? "Adding…" : "Add category"}
          </button>
        </form>
        {addState?.error && <p role="alert" className="alert-error">{addState.error}</p>}
        {addState?.ok && <p className="alert-success">{addState.message}</p>}
      </section>

      <section className="card stack-sm">
        <h2>Categories ({categories.length})</h2>
        {removeState?.error && <p role="alert" className="alert-error">{removeState.error}</p>}
        {removeState?.ok && <p className="alert-success">{removeState.message}</p>}

        {categories.length === 0 ? (
          <p className="subtle">No categories yet. Add one above.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Items using it</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Category">{c.name}</td>
                    <td data-label="Items using it" className="tabular-nums">{c.itemCount}</td>
                    <td data-label="">
                      <div className="actions actions--end">
                        <form action={removeAction}>
                          <input type="hidden" name="id" value={c.id} />
                          {/* A category in use is not removable: deleting it
                              would leave those devices holding a value that no
                              longer appears in any picker. The button is
                              disabled AND the server refuses — the disabled
                              state is a hint, the server check is the rule. */}
                          <button
                            type="submit"
                            className="btn btn-danger btn-sm"
                            disabled={removing || c.itemCount > 0}
                            title={
                              c.itemCount > 0
                                ? `Still assigned to ${c.itemCount} item${c.itemCount === 1 ? "" : "s"} — re-categorize them first.`
                                : undefined
                            }
                          >
                            Remove
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
