-- DropIndex
DROP INDEX "Fill_network_signature_maker_makerNonce_taker_takerNonce_key";

-- DropIndex
DROP INDEX "Order_owner_nonce_key";

-- AlterTable
ALTER TABLE "Fill" ADD COLUMN     "makerSubId" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "takerSubId" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "subId" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Fill_network_signature_maker_makerSubId_makerNonce_taker_ta_key" ON "Fill"("network", "signature", "maker", "makerSubId", "makerNonce", "taker", "takerSubId", "takerNonce");

-- CreateIndex
CREATE UNIQUE INDEX "Order_owner_subId_nonce_key" ON "Order"("owner", "subId", "nonce");

