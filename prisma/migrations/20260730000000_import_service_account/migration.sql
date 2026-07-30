-- The identity automated imports are attributed to.
--
-- ImportBatch.createdById is a required FK to "User", so a machine-driven
-- import still needs a row to point at. This account exists ONLY as that
-- attribution anchor.
--
-- isActive = false is what makes it non-loginable: defaultGetSession in
-- src/lib/authz.ts returns null for an inactive user, so no session can resolve
-- to it regardless of the password hash.
--
-- deactivatedAt is deliberately NULL: purgeDeactivatedUsers only hard-deletes
-- accounts with a non-null deactivatedAt, so leaving it null keeps this row
-- permanently out of scope for the purge worker. It is also independently
-- protected by hasBlockingReferences, which refuses to delete any user who
-- created import batches (ImportBatch.createdById is ON DELETE RESTRICT).
--
-- The .invalid TLD is reserved by RFC 2606 and can never be a real address.
--
-- ON CONFLICT DO NOTHING makes this migration safe to re-run / re-apply.
INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt")
VALUES (
  'svcmdmimport000000000000',
  'MDM Import (automated)',
  'mdm-import@service.invalid',
  '!no-login-service-account',
  'USER',
  false,
  NOW(),
  NOW()
)
ON CONFLICT ("email") DO NOTHING;
