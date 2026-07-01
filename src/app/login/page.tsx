"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", fontFamily: "system-ui" }}>
      <h1>Hand Receipt — Sign in</h1>
      <form action={action}>
        <label>Email<input name="email" type="email" required style={{ width: "100%" }} /></label>
        <label>Password<input name="password" type="password" required style={{ width: "100%" }} /></label>
        {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
        <button disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
