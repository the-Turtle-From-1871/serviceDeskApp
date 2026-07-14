-- Enable citext so User.email is case-insensitive at the database level: both the
-- unique constraint and every lookup then ignore case. Prisma does not manage
-- extensions unless the `postgresqlExtensions` preview feature is enabled, so
-- `migrate diff` omits this line — it is added by hand and must stay.
CREATE EXTENSION IF NOT EXISTS citext;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" SET DATA TYPE CITEXT;
