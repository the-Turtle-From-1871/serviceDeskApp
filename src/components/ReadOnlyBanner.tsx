/**
 * The visible tell that the read-only demo account is in force — rendered by
 * `src/app/admin/layout.tsx` whenever the session user is read-only. It is a
 * security control's UI half: if the env var is not set, this does not render,
 * so its presence is how someone confirms the guard is live without POSTing
 * anything.
 *
 * Legacy `globals.css` design system, NOT Tailwind — `/admin` is a pre-existing
 * page. Everything here reuses classes/custom properties that already exist:
 * `.alert-warning` (the app's attention treatment: --amber on --amber-soft with
 * an --amber-border), `.stack-sm` for the 10px column gap, and `.card__title`
 * for a 15px/600 heading.
 *
 * The three inline styles are all working around the absent Tailwind preflight,
 * which is what would normally zero UA margins:
 *  - `margin: 0` on the h2 and p, because the UA still gives them 0.83em/1em
 *    block margins; `.stack-sm`'s gap is what spaces them instead.
 *  - `marginBottom` on the section, because `.container` has no gap of its own
 *    and every admin page's root is a `.stack` (20px) — this matches it.
 * The thicker left edge is safe here precisely BECAUSE `.alert-warning` already
 * sets `border: 1px solid` on all four sides: this widens a side that is
 * already painted, rather than leaving three sides at the CSS initial `medium`
 * (3px) the way a bare single-side border would.
 */
export function ReadOnlyBanner() {
  return (
    <section
      role="status"
      className="alert-warning stack-sm"
      style={{ marginBottom: 20, borderLeftWidth: 4, borderLeftColor: "var(--amber)" }}
    >
      <h2 className="card__title" style={{ margin: 0 }}>
        Read-only demo account
      </h2>
      <p style={{ margin: 0 }}>
        You can browse everything here, but nothing you change is saved.
      </p>
    </section>
  );
}
