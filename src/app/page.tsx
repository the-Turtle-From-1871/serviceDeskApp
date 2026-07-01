import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Dashboard arrives in Plan 3; admins land on the admin console (Plan 2).
  redirect(session.user.role === "ADMIN" ? "/admin" : "/dashboard");
}
