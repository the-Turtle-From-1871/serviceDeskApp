-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "PermissionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "denialReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "PermissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionRequestItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "capability" "Capability" NOT NULL,
    "decision" "Decision" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "PermissionRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PermissionRequest_status_createdAt_idx" ON "PermissionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PermissionRequest_userId_idx" ON "PermissionRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionRequestItem_requestId_capability_key" ON "PermissionRequestItem"("requestId", "capability");

-- CreateIndex
CREATE INDEX "PermissionRequestItem_requestId_idx" ON "PermissionRequestItem"("requestId");

-- AddForeignKey
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRequestItem" ADD CONSTRAINT "PermissionRequestItem_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "PermissionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
