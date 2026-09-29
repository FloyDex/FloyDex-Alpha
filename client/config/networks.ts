/**
 * Per-network configuration. Both venues live in one bundle so the navbar
 * toggle can switch without a rebuild.
 *
 * `testnet` is Solana devnet (the live demo). `mainnet` is Solana mainnet-beta
 * and stays dark until keepers are actually running there.
 *
 * NEXT_PUBLIC_* reads stay literal member expressions so Next can inline them.
 */

export const NETWORK_IDS = ["mainnet", "testnet"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && (NETWORK_IDS as readonly string[]).includes(value);
}

const PRIMARY_RAW =
  process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? process.env.NEXT_PUBLIC_STELLAR_NETWORK;

export const PRIMARY_NETWORK: NetworkId = isNetworkId(PRIMARY_RAW) ? PRIMARY_RAW : "mainnet";

/** PDAs and the program id. Legacy stellar names stay as aliases. */
export interface ContractSet {
  programId: string;
  exchange: string;
  market: string;
  vault: string;
  insurance: string;
  settlementCollateral: string;
  solUsdPushFeed: string;
  governance: string;
  oracleAdapter: string;
  engine: string;
  orderGateway: string;
  liquidation: string;
  risk: string;
}

export interface AssetSet {
  nativeXlm: string;
  usdc: string;
  usdcIssuer: string;
}

export interface CollateralAsset {
  code: string;
  contract: string;
  issuer: string | null;
  oracleSymbol: string;
  settlement: boolean;
  bridgeDecimals?: number;
  note?: string;
}

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  shortLabel: string;
  cluster: "mainnet-beta" | "devnet";
  rpcUrl: string;
  /** Genesis hash — binds the 108-byte order domain. */
  passphrase: string;
  genesisHash: string;
  horizonUrl: string;
  explorerUrl: string;
  contracts: ContractSet;
  assets: AssetSet;
  collateral: readonly CollateralAsset[];
  keepersExpected: boolean;
}

const DEVNET_PROGRAM = "2vgBHV763RtsBZGNpnuvbkGDKJdtt1DxP9tUDo4NZxUB";
const DEVNET_EXCHANGE = "LnVD1MrMvPohtamKtrrCNH6kG992HM5grFJiA6KqnkQ";
const DEVNET_MARKET = "2kWD1pj7XLMXankFeb2LRNoyKvx2NhgLGgNwVTpAuR1q";
const DEVNET_VAULT = "8byGMd73tNV87Eam96zjvduMsmW4Q7CxupPusz8kaLCY";
const DEVNET_INSURANCE = "4wkbjVmv9wcUJTfikTgAQTdbT9R29zExuwqpN37FiKng";
const DEVNET_USDC = "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd";
const DEVNET_COLLATERAL = "49RBddCmqk7dpb2Fu6exWA5mgbjk9soeyXZYEwtDzzGR";
const DEVNET_PYTH_SOL = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function programContracts(
  programId: string,
  extras: {
    exchange: string;
    market: string;
    vault: string;
    insurance: string;
    settlementCollateral: string;
    solUsdPushFeed: string;
  }
): ContractSet {
  return {
    programId,
    ...extras,
    governance: extras.exchange,
    oracleAdapter: extras.solUsdPushFeed,
    engine: programId,
    orderGateway: programId,
    liquidation: programId,
    risk: programId,
  };
}

const MAINNET_DEFAULTS = {
  cluster: "mainnet-beta" as const,
  rpcUrl: "https://api.mainnet-beta.solana.com",
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  contracts: programContracts(DEVNET_PROGRAM, {
    exchange: DEVNET_EXCHANGE,
    market: DEVNET_MARKET,
    vault: DEVNET_VAULT,
    insurance: DEVNET_INSURANCE,
    settlementCollateral: DEVNET_COLLATERAL,
    solUsdPushFeed: DEVNET_PYTH_SOL,
  }),
  assets: {
    nativeXlm: "So11111111111111111111111111111111111111112",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdcIssuer: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  collateral: [
    {
      code: "USDC",
      contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      issuer: null,
      oracleSymbol: "USDC",
      settlement: true,
    },
  ],
};

const TESTNET_DEFAULTS = {
  cluster: "devnet" as const,
  rpcUrl: "https://api.devnet.solana.com",
  genesisHash: DEVNET_GENESIS,
  contracts: programContracts(DEVNET_PROGRAM, {
    exchange: DEVNET_EXCHANGE,
    market: DEVNET_MARKET,
    vault: DEVNET_VAULT,
    insurance: DEVNET_INSURANCE,
    settlementCollateral: DEVNET_COLLATERAL,
    solUsdPushFeed: DEVNET_PYTH_SOL,
  }),
  assets: {
    nativeXlm: "So11111111111111111111111111111111111111112",
    usdc: DEVNET_USDC,
    usdcIssuer: DEVNET_USDC,
  },
  collateral: [
    {
      code: "USDC",
      contract: DEVNET_USDC,
      issuer: null,
      oracleSymbol: "USDC",
      settlement: true,
    },
  ],
};

const OVERRIDES = {
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
  programId: process.env.NEXT_PUBLIC_PROGRAM_ID,
  vault: process.env.NEXT_PUBLIC_CONTRACT_VAULT,
  usdc: process.env.NEXT_PUBLIC_ASSET_USDC ?? process.env.NEXT_PUBLIC_USDC_MINT,
} as const;

function parseKeepersFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function buildNetwork(
  id: NetworkId,
  defaults: typeof MAINNET_DEFAULTS | typeof TESTNET_DEFAULTS
): NetworkConfig {
  const primary = id === PRIMARY_NETWORK;
  const pick = (override: string | undefined, fallback: string): string =>
    primary && override ? override : fallback;

  const isMainnet = id === "mainnet";
  const programId = pick(OVERRIDES.programId, defaults.contracts.programId);
  const usdc = pick(OVERRIDES.usdc, defaults.assets.usdc);
  const vault = pick(OVERRIDES.vault, defaults.contracts.vault);
  const contracts = {
    ...defaults.contracts,
    programId,
    vault,
    engine: programId,
    orderGateway: programId,
    liquidation: programId,
    risk: programId,
  };

  return {
    id,
    label: isMainnet ? "Solana Mainnet" : "Solana Devnet",
    shortLabel: isMainnet ? "Mainnet" : "Devnet",
    cluster: defaults.cluster,
    rpcUrl: pick(OVERRIDES.rpcUrl, defaults.rpcUrl),
    passphrase: defaults.genesisHash,
    genesisHash: defaults.genesisHash,
    horizonUrl: "",
    explorerUrl: isMainnet ? "https://solscan.io" : "https://solscan.io",
    contracts,
    assets: { ...defaults.assets, usdc, usdcIssuer: usdc },
    collateral: defaults.collateral.map((c) =>
      c.settlement ? { ...c, contract: usdc, issuer: usdc } : c
    ),
    keepersExpected: isMainnet
      ? parseKeepersFlag(process.env.NEXT_PUBLIC_MAINNET_KEEPERS_LIVE, true)
      : parseKeepersFlag(process.env.NEXT_PUBLIC_TESTNET_KEEPERS_LIVE, false),
  };
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: buildNetwork("mainnet", MAINNET_DEFAULTS),
  testnet: buildNetwork("testnet", TESTNET_DEFAULTS),
};

export function getNetworkConfig(id: NetworkId): NetworkConfig {
  return NETWORKS[id];
}

export function explorerTxUrl(explorerUrl: string, signature: string, cluster: NetworkConfig["cluster"]): string {
  const q = cluster === "devnet" ? "?cluster=devnet" : "";
  return `${explorerUrl}/tx/${signature}${q}`;
}
