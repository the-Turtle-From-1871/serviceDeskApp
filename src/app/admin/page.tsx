import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";

export default async function AdminHome() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  redirect("/items");
}
