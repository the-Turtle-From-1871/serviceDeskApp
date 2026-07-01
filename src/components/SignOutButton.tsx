import { logoutAction } from "@/app/actions/auth";
export function SignOutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit">Sign out</button>
    </form>
  );
}
