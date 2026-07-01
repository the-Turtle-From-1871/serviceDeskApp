import { logoutAction } from "@/app/actions/auth";
export function SignOutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
    </form>
  );
}
