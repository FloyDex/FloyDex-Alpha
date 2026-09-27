-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "KeeperActionStatus" AS ENUM ('PLANNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "StatsPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'ALL');

-- CreateEnum
CREATE TYPE "PnlEventKind" AS ENUM ('REALIZED_TRADE', 'FUNDING', 'LIQUIDATION', 'FEE');

-- CreateEnum
CREATE TYPE "BalanceChangeKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateTable
CREATE TABLE "SlotCursor" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "replayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "settlementMint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastPrice" TEXT NOT NULL DEFAULT '0',
    "volume" TEXT NOT NULL DEFAULT '0',
    "longOpenInterest" TEXT NOT NULL DEFAULT '0',
    "shortOpenInterest" TEXT NOT NULL DEFAULT '0',
    "fundingLongIndex" TEXT NOT NULL DEFAULT '0',
    "fundingShortIndex" TEXT NOT NULL DEFAULT '0',
    "lastOraclePrice" TEXT NOT NULL DEFAULT '0',
    "lastOracleSlot" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "address" TEXT NOT NULL,
    "collateral" JSONB NOT NULL DEFAULT '{}',
    "cancelledNonces" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "filledByNonce" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "isLong" BOOLEAN NOT NULL,
    "size" TEXT NOT NULL,
    "limitPrice" TEXT NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL,
    "nonce" BIGINT NOT NULL,
    "expiryTs" BIGINT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "filledSize" TEXT NOT NULL DEFAULT '0',
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "maker" TEXT NOT NULL,
    "makerNonce" BIGINT NOT NULL,
    "taker" TEXT NOT NULL,
    "takerNonce" BIGINT NOT NULL,
    "fillSize" TEXT NOT NULL,
    "fillPrice" TEXT NOT NULL,
    "feeMaker" TEXT NOT NULL DEFAULT '0',
    "feeTaker" TEXT NOT NULL DEFAULT '0',
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OracleSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "asset" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "publishTime" BIGINT NOT NULL,
    "writeTime" BIGINT NOT NULL,
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingUpdate" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "longIndex" TEXT NOT NULL,
    "shortIndex" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxJob" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "unsignedTx" TEXT,
    "signedTx" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "TxStatus" NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "signature" TEXT,
    "slot" BIGINT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TxJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeeperAction" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "marketId" INTEGER,
    "account" TEXT,
    "payload" JSONB NOT NULL,
    "status" "KeeperActionStatus" NOT NULL DEFAULT 'PLANNED',
    "txJobId" BIGINT,
    "slot" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeeperAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentArtifact" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractName" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "wasmHash" TEXT NOT NULL,
    "gitCommit" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceProposal" (
    "id" BIGINT NOT NULL,
    "network" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "wasmHash" TEXT,
    "eta" BIGINT NOT NULL,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "severity" "AuditSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderStat" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "period" "StatsPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "volume" TEXT NOT NULL DEFAULT '0',
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "winningTrades" INTEGER NOT NULL DEFAULT 0,
    "losingTrades" INTEGER NOT NULL DEFAULT 0,
    "winRate" TEXT NOT NULL DEFAULT '0',
    "roi" TEXT NOT NULL DEFAULT '0',
    "feesPaid" TEXT NOT NULL DEFAULT '0',
    "fundingPaid" TEXT NOT NULL DEFAULT '0',
    "liquidationCount" INTEGER NOT NULL DEFAULT 0,
    "liquidatedVolume" TEXT NOT NULL DEFAULT '0',
    "peakCollateral" TEXT NOT NULL DEFAULT '0',
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "referralVolume" TEXT NOT NULL DEFAULT '0',
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "period" "StatsPeriod" NOT NULL,
    "metric" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rankings" JSONB NOT NULL,
    "traderCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceChange" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "kind" "BalanceChangeKind" NOT NULL,
    "amount" TEXT NOT NULL,
    "balanceAfter" TEXT,
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PnlEvent" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "kind" "PnlEventKind" NOT NULL,
    "amount" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '0',
    "price" TEXT NOT NULL DEFAULT '0',
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PnlEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingPayment" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "fundingIndex" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "collateralValue" TEXT NOT NULL DEFAULT '0',
    "equity" TEXT NOT NULL DEFAULT '0',
    "unrealizedPnl" TEXT NOT NULL DEFAULT '0',
    "realizedPnlCum" TEXT NOT NULL DEFAULT '0',
    "freeCollateral" TEXT NOT NULL DEFAULT '0',
    "usedMargin" TEXT NOT NULL DEFAULT '0',
    "maintenanceMargin" TEXT NOT NULL DEFAULT '0',
    "marginRatio" TEXT NOT NULL DEFAULT '0',
    "openPositionCount" INTEGER NOT NULL DEFAULT 0,
    "longExposure" TEXT NOT NULL DEFAULT '0',
    "shortExposure" TEXT NOT NULL DEFAULT '0',
    "liquidatable" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAnalytics" (
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "realizedPnlAll" TEXT NOT NULL DEFAULT '0',
    "volumeAll" TEXT NOT NULL DEFAULT '0',
    "tradeCountAll" INTEGER NOT NULL DEFAULT 0,
    "winRateAll" TEXT NOT NULL DEFAULT '0',
    "totalDeposited" TEXT NOT NULL DEFAULT '0',
    "totalWithdrawn" TEXT NOT NULL DEFAULT '0',
    "totalFundingPaid" TEXT NOT NULL DEFAULT '0',
    "totalFeesPaid" TEXT NOT NULL DEFAULT '0',
    "liquidationCount" INTEGER NOT NULL DEFAULT 0,
    "maxDrawdown" TEXT NOT NULL DEFAULT '0',
    "firstTradeAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAnalytics_pkey" PRIMARY KEY ("network","address")
);

-- CreateIndex
CREATE INDEX "SlotCursor_network_slot_idx" ON "SlotCursor"("network", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "SlotCursor_network_programId_key" ON "SlotCursor"("network", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolEvent_replayKey_key" ON "ProtocolEvent"("replayKey");

-- CreateIndex
CREATE INDEX "ProtocolEvent_network_slot_idx" ON "ProtocolEvent"("network", "slot");

-- CreateIndex
CREATE INDEX "ProtocolEvent_signature_idx" ON "ProtocolEvent"("signature");

-- CreateIndex
CREATE INDEX "ProtocolEvent_topic_idx" ON "ProtocolEvent"("topic");

-- CreateIndex
CREATE UNIQUE INDEX "Market_symbol_key" ON "Market"("symbol");

-- CreateIndex
CREATE INDEX "Order_marketId_isLong_limitPrice_idx" ON "Order"("marketId", "isLong", "limitPrice");

-- CreateIndex
CREATE INDEX "Order_expiryTs_idx" ON "Order"("expiryTs");

-- CreateIndex
CREATE UNIQUE INDEX "Order_owner_nonce_key" ON "Order"("owner", "nonce");

-- CreateIndex
CREATE INDEX "Fill_marketId_slot_idx" ON "Fill"("marketId", "slot");

-- CreateIndex
CREATE INDEX "Fill_maker_idx" ON "Fill"("maker");

-- CreateIndex
CREATE INDEX "Fill_taker_idx" ON "Fill"("taker");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_network_signature_maker_makerNonce_taker_takerNonce_key" ON "Fill"("network", "signature", "maker", "makerNonce", "taker", "takerNonce");

-- CreateIndex
CREATE INDEX "OracleSnapshot_marketId_slot_idx" ON "OracleSnapshot"("marketId", "slot");

-- CreateIndex
CREATE INDEX "OracleSnapshot_asset_publishTime_idx" ON "OracleSnapshot"("asset", "publishTime");

-- CreateIndex
CREATE UNIQUE INDEX "OracleSnapshot_network_asset_publishTime_source_key" ON "OracleSnapshot"("network", "asset", "publishTime", "source");

-- CreateIndex
CREATE INDEX "FundingUpdate_marketId_slot_idx" ON "FundingUpdate"("marketId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "FundingUpdate_network_marketId_slot_signature_key" ON "FundingUpdate"("network", "marketId", "slot", "signature");

-- CreateIndex
CREATE INDEX "TxJob_status_nextAttemptAt_idx" ON "TxJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TxJob_signature_idx" ON "TxJob"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "TxJob_network_kind_payloadHash_key" ON "TxJob"("network", "kind", "payloadHash");

-- CreateIndex
CREATE INDEX "KeeperAction_network_kind_status_idx" ON "KeeperAction"("network", "kind", "status");

-- CreateIndex
CREATE INDEX "KeeperAction_marketId_idx" ON "KeeperAction"("marketId");

-- CreateIndex
CREATE INDEX "DeploymentArtifact_wasmHash_idx" ON "DeploymentArtifact"("wasmHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentArtifact_network_contractName_key" ON "DeploymentArtifact"("network", "contractName");

-- CreateIndex
CREATE INDEX "GovernanceProposal_network_eta_idx" ON "GovernanceProposal"("network", "eta");

-- CreateIndex
CREATE INDEX "AuditFinding_severity_status_idx" ON "AuditFinding"("severity", "status");

-- CreateIndex
CREATE INDEX "AuditFinding_component_idx" ON "AuditFinding"("component");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_realizedPnl_idx" ON "TraderStat"("network", "period", "realizedPnl");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_volume_idx" ON "TraderStat"("network", "period", "volume");

-- CreateIndex
CREATE INDEX "TraderStat_network_period_roi_idx" ON "TraderStat"("network", "period", "roi");

-- CreateIndex
CREATE INDEX "TraderStat_address_idx" ON "TraderStat"("address");

-- CreateIndex
CREATE UNIQUE INDEX "TraderStat_network_address_period_key" ON "TraderStat"("network", "address", "period");

-- CreateIndex
CREATE INDEX "LeaderboardSnapshot_lookup_idx" ON "LeaderboardSnapshot"("network", "period", "metric", "capturedAt");

-- CreateIndex
CREATE INDEX "BalanceChange_acct_time_idx" ON "BalanceChange"("network", "address", "createdAt");

-- CreateIndex
CREATE INDEX "BalanceChange_address_idx" ON "BalanceChange"("address");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceChange_unique_idx" ON "BalanceChange"("network", "signature", "address", "kind");

-- CreateIndex
CREATE INDEX "PnlEvent_acct_time_idx" ON "PnlEvent"("network", "address", "createdAt");

-- CreateIndex
CREATE INDEX "PnlEvent_market_kind_idx" ON "PnlEvent"("marketId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PnlEvent_unique_idx" ON "PnlEvent"("network", "address", "kind", "refKey");

-- CreateIndex
CREATE INDEX "FundingPayment_acct_time_idx" ON "FundingPayment"("network", "address", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FundingPayment_unique_idx" ON "FundingPayment"("network", "address", "marketId", "fundingIndex");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_acct_time_idx" ON "PortfolioSnapshot"("network", "address", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountAnalytics_network_idx" ON "AccountAnalytics"("network");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_owner_fkey" FOREIGN KEY ("owner") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_maker_fkey" FOREIGN KEY ("maker") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_taker_fkey" FOREIGN KEY ("taker") REFERENCES "Account"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OracleSnapshot" ADD CONSTRAINT "OracleSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingUpdate" ADD CONSTRAINT "FundingUpdate_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeeperAction" ADD CONSTRAINT "KeeperAction_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;
