-- Single-row config table for the public-access PIN gate. Stores only the
-- bcrypt hash of the shared 8-digit PIN. RLS is auto-enabled (deny-all) by the
-- rls_auto_enable event trigger; access is app-layer via Prisma only.
CREATE TABLE "PublicAccessSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "pinHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "PublicAccessSetting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublicAccessSetting_updatedById_idx" ON "PublicAccessSetting"("updatedById");

ALTER TABLE "PublicAccessSetting" ADD CONSTRAINT "PublicAccessSetting_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
