import "server-only";
import prisma from "@/lib/prisma";

/** The address of the seeded, non-loginable account automated imports are
 *  attributed to. `.invalid` is reserved by RFC 2606, so this can never
 *  collide with a real person's address. */
export const IMPORT_SERVICE_ACCOUNT_EMAIL = "mdm-import@service.invalid";

/**
 * The `editor` identity an automated import writes its history under.
 *
 * THROWS rather than falling back to any other account. Silently importing as
 * "whoever we found" would attribute a machine's mass edit to a real person, so
 * a missing service account must be a loud failure that returns a 500 and gets
 * fixed, not a quiet substitution.
 */
export async function getImportActor(): Promise<{ id: string; name: string }> {
  const user = await prisma.user.findUnique({
    where: { email: IMPORT_SERVICE_ACCOUNT_EMAIL },
    select: { id: true, name: true },
  });
  if (!user) {
    throw new Error(
      `Import service account (${IMPORT_SERVICE_ACCOUNT_EMAIL}) is missing. ` +
        "Apply the import_service_account migration.",
    );
  }
  return user;
}
