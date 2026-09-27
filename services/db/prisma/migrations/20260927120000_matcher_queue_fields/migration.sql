-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "queuedSize" TEXT NOT NULL DEFAULT '0',
ADD COLUMN     "signerPubkey" TEXT;

-- AlterTable
ALTER TABLE "TxJob" ADD COLUMN     "payload" JSONB;
