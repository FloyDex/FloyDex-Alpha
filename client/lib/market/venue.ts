import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEE_COLLECTOR, MARKETS, PLATFORM_FEE_BPS } from "@/config";
import {
  giftClaimDenied,
  giftWithdrawError,
  recordGiftClaim,
  toGiftStatus,
  topUpGiftCredit,
  GIFT_USD,
  type GiftClaims,
} from "./gift";
import { fetchMarkUsd } from "./marks";
import { sendTreasuryUsdc } from "@/lib/solana/treasury";

export interface VenuePosition {
  marketId: number;
  isLong: boolean;
  size: number;
  entry: number;
  margin: number;
  tp?: number | null;
  sl?: number | null;
}

export interface VenueFill {
  id: string;
  marketId: number;
  /** Taker side of this print. */
  isLong: boolean;
  size: number;
  price: number;
  /** Realized pnl on closes; 0 on opens/adds. */
  pnl: number;
  /** Platform fee charged on this fill (USDC). */
  fee?: number;
  reason: "open" | "add" | "close" | "tp" | "sl";
  at: number;
}

export interface VenueTransfer {
  id: string;
  kind: "deposit" | "withdraw";
  amount: number;
  balanceAfter: number;
  signature?: string;
  at: number;
}

export interface VenueAccount {
  owner: string;
  deposited: number;
  realized: number;
  positions: VenuePosition[];
  fills?: VenueFill[];
  transfers?: VenueTransfer[];
  seenDeposits: string[];
  /** Real USDC deposited (excludes signup gift). */
  fundedIn?: number;
  /** Completed withdrawals (auto + admin-approved). */
  fundedOut?: number;
  pendingTpSl?: Record<string, { tp?: number | null; sl?: number | null }>;
  /** Cumulative platform fees paid (USDC). */
  feesPaid?: number;
  giftUsd?: number;
  giftRealized?: number;
  giftClaimedAt?: number;
}

export interface PayoutRequest {
  id: string;
  owner: string;
  amount: number;
  /** How much of this request exceeds remaining principal. */
  overPrincipal: number;
  principalLeft: number;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedAt?: number;
  signature?: string;
  note?: string;
}

interface GiftClaimStore {
  byOwner: Record<string, { ip: string; device: string; at: number }>;
  byIp: Record<string, string>;
  byDevice: Record<string, string>;
}

export interface WalletBan {
  owner: string;
  at: number;
  reason?: string;
}

interface VenueState {
  accounts: Record<string, VenueAccount>;
  claims?: GiftClaimStore;
  payouts?: PayoutRequest[];
  /** Fees charged but not yet sent on-chain to FEE_COLLECTOR. */
  feesPending?: number;
  /** Fees successfully sent to FEE_COLLECTOR. */
  feesSent?: number;
  /** Banned wallets — cannot deposit, withdraw, trade, gift, or stake. */
  bans?: Record<string, WalletBan>;
}

const FILE = join(process.cwd(), ".data", "venue.json");

function empty(owner: string): VenueAccount {
  return {
    owner,
    deposited: 0,
    realized: 0,
    positions: [],
    fills: [],
    transfers: [],
    seenDeposits: [],
    fundedIn: 0,
    fundedOut: 0,
  };
}

function ensureFundingFields(acct: VenueAccount): boolean {
  let changed = false;
  if (acct.fundedIn == null || acct.fundedOut == null) {
    // Best-effort backfill: treat non-gift deposit stock as remaining principal.
    const gift = acct.giftUsd ?? 0;
    acct.fundedOut = acct.fundedOut ?? 0;
    acct.fundedIn = acct.fundedIn ?? Math.max(0, acct.deposited - gift + acct.fundedOut);
    changed = true;
  }
  if (!acct.transfers) {
    acct.transfers = [];
    changed = true;
  }
  // One-time synthesize so older desks still show deposit/withdraw rows.
  if (acct.transfers.length === 0 && ((acct.fundedIn ?? 0) > 0 || (acct.fundedOut ?? 0) > 0)) {
    const inAmt = acct.fundedIn ?? 0;
    const outAmt = acct.fundedOut ?? 0;
    if (inAmt > 0) {
      acct.transfers.push({
        id: `${acct.owner}:deposit:backfill`,
        kind: "deposit",
        amount: inAmt,
        balanceAfter: inAmt,
        at: Date.now() - 86_400_000,
      });
    }
    if (outAmt > 0) {
      acct.transfers.push({
        id: `${acct.owner}:withdraw:backfill`,
        kind: "withdraw",
        amount: outAmt,
        balanceAfter: Math.max(0, inAmt - outAmt),
        at: Date.now() - 3_600_000,
      });
    }
    changed = true;
  }
  return changed;
}

function pushTransfer(
  acct: VenueAccount,
  kind: "deposit" | "withdraw",
  amount: number,
  signature?: string,
) {
  if (!acct.transfers) acct.transfers = [];
  const balanceAfter = Math.max(0, accountEquity(acct, 0));
  acct.transfers = [
    {
      id: `${acct.owner}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      kind,
      amount,
      balanceAfter,
      signature,
      at: Date.now(),
    },
    ...acct.transfers,
  ].slice(0, 200);
}

function accountEquity(acct: VenueAccount, upnl = 0): number {
  return acct.deposited + acct.realized + upnl - (acct.feesPaid ?? 0);
}

function platformFeeUsdc(size: number, price: number): number {
  return (size * price * PLATFORM_FEE_BPS) / 10_000;
}

/** Debit the trader and accrue protocol fees awaiting on-chain payout to FEE_COLLECTOR. */
function chargePlatformFee(state: VenueState, acct: VenueAccount, fee: number): void {
  if (!(fee > 0)) return;
  acct.feesPaid = (acct.feesPaid ?? 0) + fee;
  state.feesPending = (state.feesPending ?? 0) + fee;
}

async function flushProtocolFees(): Promise<void> {
  const state = load();
  const pending = state.feesPending ?? 0;
  // Batch small fills; still flush from ~1¢ so the collector receives regularly.
  if (pending < 0.01) return;
  const sendAmt = Math.floor(pending * 1e6) / 1e6;
  if (!(sendAmt > 0)) return;
  const sent = await sendTreasuryUsdc(FEE_COLLECTOR, sendAmt);
  if (!sent.ok) return;
  state.feesPending = Math.max(0, (state.feesPending ?? 0) - sendAmt);
  state.feesSent = (state.feesSent ?? 0) + sendAmt;
  persist(state);
}

export function principalLeft(acct: VenueAccount): number {
  ensureFundingFields(acct);
  return Math.max(0, (acct.fundedIn ?? 0) - (acct.fundedOut ?? 0));
}

function load(): VenueState {
  const g = globalThis as typeof globalThis & { __floydexVenue?: VenueState };
  if (g.__floydexVenue) return g.__floydexVenue;
  try {
    g.__floydexVenue = JSON.parse(readFileSync(FILE, "utf8")) as VenueState;
  } catch {
    g.__floydexVenue = { accounts: {} };
  }
  return g.__floydexVenue;
}

function emptyClaims(): GiftClaimStore {
  return { byOwner: {}, byIp: {}, byDevice: {} };
}

function claimsOf(state: VenueState): GiftClaims {
  if (!state.claims) state.claims = emptyClaims();
  return state.claims;
}

function persist(state: VenueState) {
  try {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

function normalizeOwner(owner: string): string {
  return owner.trim();
}

export function isBanned(owner: string): boolean {
  const key = normalizeOwner(owner);
  if (!key) return false;
  return Boolean(load().bans?.[key]);
}

export function getBan(owner: string): WalletBan | null {
  const key = normalizeOwner(owner);
  return load().bans?.[key] ?? null;
}

export function listBans(): WalletBan[] {
  const bans = load().bans ?? {};
  return Object.values(bans).sort((a, b) => b.at - a.at);
}

export function banWallet(
  owner: string,
  reason?: string,
): { ok: true; ban: WalletBan } | { ok: false; error: string } {
  const key = normalizeOwner(owner);
  if (!key) return { ok: false, error: "Invalid wallet" };
  const state = load();
  if (!state.bans) state.bans = {};
  const ban: WalletBan = {
    owner: key,
    at: Date.now(),
    reason: reason?.trim() || undefined,
  };
  state.bans[key] = ban;
  persist(state);
  return { ok: true, ban };
}

export function unbanWallet(owner: string): { ok: true } | { ok: false; error: string } {
  const key = normalizeOwner(owner);
  const state = load();
  if (!state.bans?.[key]) return { ok: false, error: "Not banned" };
  delete state.bans[key];
  persist(state);
  return { ok: true };
}

/** Standard 403 body when a banned wallet hits a mutating desk endpoint. */
export function bannedError() {
  return { ok: false as const, error: "This wallet is banned from FloyDex", code: "banned" as const };
}

export function getAccount(owner: string): VenueAccount {
  const state = load();
  if (!state.accounts[owner]) state.accounts[owner] = empty(owner);
  const acct = state.accounts[owner];
  const fundingChanged = ensureFundingFields(acct);
  // Pick up fills repaired on disk while the process still holds an older in-memory copy.
  if (!(acct.fills?.length)) {
    try {
      const disk = JSON.parse(readFileSync(FILE, "utf8")) as VenueState;
      const diskFills = disk.accounts[owner]?.fills;
      if (diskFills?.length) acct.fills = diskFills;
    } catch {
      /* ignore */
    }
  }
  const next = topUpGiftCredit(acct.giftUsd ?? 0, acct.deposited);
  if (next.credited > 0) {
    acct.giftUsd = next.giftUsd;
    acct.deposited = next.deposited;
    persist(state);
  } else if (fundingChanged) {
    persist(state);
  }
  return acct;
}

/** All venue accounts that have traded or hold a balance (read-only snapshot). */
export function listVenueAccounts(): VenueAccount[] {
  const state = load();
  // Refresh fills from disk for accounts that look empty in memory.
  try {
    const disk = JSON.parse(readFileSync(FILE, "utf8")) as VenueState;
    for (const [owner, diskAcct] of Object.entries(disk.accounts ?? {})) {
      if (!state.accounts[owner]) state.accounts[owner] = diskAcct;
      else if (!(state.accounts[owner]!.fills?.length) && diskAcct.fills?.length) {
        state.accounts[owner]!.fills = diskAcct.fills;
      }
    }
  } catch {
    /* ignore */
  }
  return Object.values(state.accounts).map((a) => {
    ensureFundingFields(a);
    return {
      ...a,
      positions: [...(a.positions ?? [])],
      fills: [...(a.fills ?? [])],
    };
  });
}

export type DeskFillRow = VenueFill & { owner: string };
export type DeskTransferRow = VenueTransfer & { owner: string };

/** Aggregated desk metrics for the admin console. */
export function deskOverview() {
  const state = load();
  const accounts = listVenueAccounts();
  const now = Date.now();
  const dayAgo = now - 86_400_000;

  let fundedIn = 0;
  let fundedOut = 0;
  let ledgerEquity = 0;
  let usedMargin = 0;
  let feesPaid = 0;
  let giftOutstanding = 0;
  let giftClaimed = 0;
  let openPositions = 0;
  let tradersWithBalance = 0;
  let tradersWithPositions = 0;
  let volume24h = 0;
  let fees24h = 0;
  let fills24h = 0;
  let deposits24h = 0;
  let withdraws24h = 0;

  const oiByMarket: Record<
    number,
    { marketId: number; symbol: string; long: number; short: number; notional: number; traders: number }
  > = {};
  const allFills: DeskFillRow[] = [];
  const allTransfers: DeskTransferRow[] = [];

  for (const acct of accounts) {
    ensureFundingFields(acct);
    const fi = acct.fundedIn ?? 0;
    const fo = acct.fundedOut ?? 0;
    fundedIn += fi;
    fundedOut += fo;
    const fee = acct.feesPaid ?? 0;
    feesPaid += fee;
    const giftLeft = Math.max(0, (acct.giftUsd ?? 0) - (acct.giftRealized ?? 0));
    giftOutstanding += giftLeft;
    if ((acct.giftUsd ?? 0) > 0) giftClaimed += 1;

    let margin = 0;
    for (const p of acct.positions ?? []) {
      if (!(p.size > 0)) continue;
      openPositions += 1;
      margin += p.margin;
      const cfg = marketCfg(p.marketId);
      const slot = (oiByMarket[p.marketId] ??= {
        marketId: p.marketId,
        symbol: cfg?.symbol ?? `M${p.marketId}`,
        long: 0,
        short: 0,
        notional: 0,
        traders: 0,
      });
      if (p.isLong) slot.long += p.size;
      else slot.short += p.size;
      slot.notional += p.size * p.entry;
      slot.traders += 1;
    }
    usedMargin += margin;
    const equity = accountEquity(acct, 0);
    ledgerEquity += equity;
    if (equity > 0.0001 || fi > 0 || (acct.fills?.length ?? 0) > 0) tradersWithBalance += 1;
    if ((acct.positions ?? []).some((p) => p.size > 0)) tradersWithPositions += 1;

    for (const f of acct.fills ?? []) {
      allFills.push({ ...f, owner: acct.owner });
      if (f.at >= dayAgo) {
        fills24h += 1;
        volume24h += f.size * f.price;
        fees24h += f.fee ?? 0;
      }
    }
    for (const t of acct.transfers ?? []) {
      allTransfers.push({ ...t, owner: acct.owner });
      if (t.at >= dayAgo) {
        if (t.kind === "deposit") deposits24h += t.amount;
        else withdraws24h += t.amount;
      }
    }
  }

  const payouts = state.payouts ?? [];
  const pendingPayouts = payouts.filter((p) => p.status === "pending");
  const pendingPayoutUsd = pendingPayouts.reduce((s, p) => s + p.amount, 0);

  allFills.sort((a, b) => b.at - a.at);
  allTransfers.sort((a, b) => b.at - a.at);

  return {
    generatedAt: now,
    feeCollector: FEE_COLLECTOR,
    platformFeeBps: PLATFORM_FEE_BPS,
    vault: {
      fundedIn,
      fundedOut,
      netPrincipal: Math.max(0, fundedIn - fundedOut),
      ledgerEquity,
      usedMargin,
      freeCollateral: ledgerEquity - usedMargin,
    },
    fees: {
      paid: feesPaid,
      pending: state.feesPending ?? 0,
      sent: state.feesSent ?? 0,
    },
    traders: {
      accounts: accounts.length,
      withBalance: tradersWithBalance,
      withPositions: tradersWithPositions,
      openPositions,
      giftClaims: giftClaimed,
      giftOutstanding,
    },
    flow24h: {
      volume: volume24h,
      fees: fees24h,
      fills: fills24h,
      deposits: deposits24h,
      withdraws: withdraws24h,
    },
    payouts: {
      pendingCount: pendingPayouts.length,
      pendingUsd: pendingPayoutUsd,
      total: payouts.length,
    },
    markets: Object.values(oiByMarket).sort((a, b) => b.notional - a.notional),
    recentFills: allFills.slice(0, 25),
    recentTransfers: allTransfers.slice(0, 25),
  };
}

/** Compact trader rows for the admin traders table. */
export function deskTraders() {
  const state = load();
  const payouts = state.payouts ?? [];
  const accounts = listVenueAccounts();
  return accounts
    .map((acct) => {
      ensureFundingFields(acct);
      const used = (acct.positions ?? []).reduce((s, p) => s + (p.size > 0 ? p.margin : 0), 0);
      const equity = accountEquity(acct, 0);
      const volume = (acct.fills ?? []).reduce((s, f) => s + f.size * f.price, 0);
      const mine = payouts.filter((p) => p.owner === acct.owner);
      const pending = mine.filter((p) => p.status === "pending");
      const approved = mine.filter((p) => p.status === "approved");
      const rejected = mine.filter((p) => p.status === "rejected");
      const latestPayout = [...mine].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      return {
        owner: acct.owner,
        equity,
        deposited: acct.deposited,
        realized: acct.realized,
        feesPaid: acct.feesPaid ?? 0,
        fundedIn: acct.fundedIn ?? 0,
        fundedOut: acct.fundedOut ?? 0,
        principalLeft: principalLeft(acct),
        usedMargin: used,
        freeCollateral: equity - used,
        positions: (acct.positions ?? []).filter((p) => p.size > 0).length,
        fills: acct.fills?.length ?? 0,
        volume,
        giftUsd: acct.giftUsd ?? 0,
        giftLeft: Math.max(0, (acct.giftUsd ?? 0) - (acct.giftRealized ?? 0)),
        banned: isBanned(acct.owner),
        ban: getBan(acct.owner),
        payouts: {
          pendingCount: pending.length,
          pendingUsd: pending.reduce((s, p) => s + p.amount, 0),
          approvedCount: approved.length,
          approvedUsd: approved.reduce((s, p) => s + p.amount, 0),
          rejectedCount: rejected.length,
          rejectedUsd: rejected.reduce((s, p) => s + p.amount, 0),
          totalCount: mine.length,
          latest: latestPayout
            ? {
                id: latestPayout.id,
                amount: latestPayout.amount,
                status: latestPayout.status,
                createdAt: latestPayout.createdAt,
                resolvedAt: latestPayout.resolvedAt,
              }
            : null,
        },
        lastFillAt: acct.fills?.length ? Math.max(...acct.fills.map((f) => f.at)) : 0,
        lastTransferAt: acct.transfers?.length ? Math.max(...acct.transfers.map((t) => t.at)) : 0,
      };
    })
    .filter((t) => t.fundedIn > 0 || t.fills > 0 || t.equity > 0.0001 || t.giftUsd > 0 || t.payouts.totalCount > 0)
    .sort((a, b) => b.equity - a.equity || b.volume - a.volume);
}

function marketCfg(id: number) {
  return Object.values(MARKETS).find((m) => m.marketId === id);
}

export function listMarketPositions(marketId: number): VenuePosition[] {
  const state = load();
  const out: VenuePosition[] = [];
  for (const acct of Object.values(state.accounts)) {
    for (const p of acct.positions) {
      if (p.marketId === marketId && p.size > 0) out.push({ ...p });
    }
  }
  return out;
}

export async function snapshot(owner: string) {
  const acct = getAccount(owner);
  let upnl = 0;
  let used = 0;
  const marks: Record<number, number> = {};
  for (const p of acct.positions) {
    used += p.margin;
    const mark = (marks[p.marketId] = marks[p.marketId] ?? (await fetchMarkUsd(p.marketId)) ?? p.entry);
    const dir = p.isLong ? 1 : -1;
    upnl += (mark - p.entry) * p.size * dir;
  }
  const equity = accountEquity(acct, upnl);
  const free = equity - used;
  const principal = principalLeft(acct);
  const pending = (load().payouts ?? []).filter(
    (p) => p.owner === owner && p.status === "pending",
  );
  return {
    owner,
    deposited: acct.deposited,
    realized: acct.realized,
    upnl,
    equity,
    usedMargin: used,
    freeCollateral: free,
    feesPaid: acct.feesPaid ?? 0,
    fundedIn: acct.fundedIn ?? 0,
    fundedOut: acct.fundedOut ?? 0,
    principalLeft: principal,
    pendingPayouts: pending,
    positions: acct.positions,
    fills: [...(acct.fills ?? [])].sort((a, b) => b.at - a.at).slice(0, 100),
    transfers: [...(acct.transfers ?? [])].sort((a, b) => b.at - a.at).slice(0, 100),
    marks,
    gift: toGiftStatus(acct.giftUsd ?? 0, acct.giftRealized ?? 0),
    banned: isBanned(owner),
    ban: getBan(owner),
  };
}

export function creditUsdc(owner: string, amountUsdc: number) {
  const state = load();
  getAccount(owner).deposited += amountUsdc;
  persist(state);
}

export function creditDeposit(owner: string, amountUsdc: number, signature: string): boolean {
  const state = load();
  const acct = getAccount(owner);
  if (acct.seenDeposits.includes(signature)) return false;
  acct.seenDeposits.push(signature);
  acct.deposited += amountUsdc;
  ensureFundingFields(acct);
  acct.fundedIn = (acct.fundedIn ?? 0) + amountUsdc;
  pushTransfer(acct, "deposit", amountUsdc, signature);
  persist(state);
  return true;
}

export function debitWithdraw(owner: string, amountUsdc: number): { ok: true } | { ok: false; error: string } {
  const state = load();
  const acct = getAccount(owner);
  const giftErr = giftWithdrawError(acct.giftUsd ?? 0, acct.giftRealized ?? 0);
  if (giftErr) return { ok: false, error: giftErr };
  const used = acct.positions.reduce((s, p) => s + p.margin, 0);
  const free = accountEquity(acct) - used;
  if (amountUsdc > free + 1e-9) return { ok: false, error: "Insufficient free collateral" };
  acct.deposited -= amountUsdc;
  persist(state);
  return { ok: true };
}

/** Record a completed on-chain / admin payout against principal tracking. */
export function recordFundedOut(owner: string, amountUsdc: number, signature?: string) {
  const state = load();
  const acct = getAccount(owner);
  ensureFundingFields(acct);
  acct.fundedOut = (acct.fundedOut ?? 0) + amountUsdc;
  pushTransfer(acct, "withdraw", amountUsdc, signature);
  persist(state);
}

/**
 * Auto USDC only returns remaining funded deposits (fundedIn − fundedOut).
 * Anything above that — profit and/or unlocked gift — is a manual payout
 * for admin approval. Never auto-send when withdrawal > funded principal.
 */
export function requestWithdraw(owner: string, amountUsdc: number):
  | { ok: true; mode: "auto"; principalLeft: number }
  | { ok: true; mode: "manual"; payout: PayoutRequest }
  | { ok: false; error: string } {
  const state = load();
  const acct = getAccount(owner);
  const giftErr = giftWithdrawError(acct.giftUsd ?? 0, acct.giftRealized ?? 0);
  if (giftErr) return { ok: false, error: giftErr };
  if (!(amountUsdc > 0)) return { ok: false, error: "Invalid amount" };

  const used = acct.positions.reduce((s, p) => s + p.margin, 0);
  const free = accountEquity(acct) - used;
  if (amountUsdc > free + 1e-9) {
    return { ok: false, error: "Insufficient free collateral" };
  }

  const left = principalLeft(acct);
  // Withdrawal above funded deposits → admin must approve.
  if (amountUsdc > left + 1e-9) {
    const debit = debitWithdraw(owner, amountUsdc);
    if (!debit.ok) return debit;
    if (!state.payouts) state.payouts = [];
    const payout: PayoutRequest = {
      id: `${owner.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      owner,
      amount: amountUsdc,
      overPrincipal: amountUsdc - left,
      principalLeft: left,
      status: "pending",
      createdAt: Date.now(),
    };
    state.payouts.unshift(payout);
    persist(state);
    return { ok: true, mode: "manual", payout };
  }

  const debit = debitWithdraw(owner, amountUsdc);
  if (!debit.ok) return debit;
  return { ok: true, mode: "auto", principalLeft: left };
}

export function listPayouts(filter?: { status?: PayoutRequest["status"]; owner?: string }): PayoutRequest[] {
  const state = load();
  let rows = [...(state.payouts ?? [])];
  if (filter?.status) rows = rows.filter((p) => p.status === filter.status);
  if (filter?.owner) rows = rows.filter((p) => p.owner === filter.owner);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export function getPayout(id: string): PayoutRequest | null {
  return (load().payouts ?? []).find((p) => p.id === id) ?? null;
}

export function approvePayout(id: string, signature: string): { ok: true; payout: PayoutRequest } | { ok: false; error: string } {
  const state = load();
  const payout = (state.payouts ?? []).find((p) => p.id === id);
  if (!payout) return { ok: false, error: "Payout not found" };
  if (payout.status !== "pending") return { ok: false, error: "Payout already resolved" };
  payout.status = "approved";
  payout.resolvedAt = Date.now();
  payout.signature = signature;
  const acct = getAccount(payout.owner);
  ensureFundingFields(acct);
  acct.fundedOut = (acct.fundedOut ?? 0) + payout.amount;
  pushTransfer(acct, "withdraw", payout.amount, signature);
  persist(state);
  return { ok: true, payout };
}

export function rejectPayout(id: string, note?: string): { ok: true; payout: PayoutRequest } | { ok: false; error: string } {
  const state = load();
  const payout = (state.payouts ?? []).find((p) => p.id === id);
  if (!payout) return { ok: false, error: "Payout not found" };
  if (payout.status !== "pending") return { ok: false, error: "Payout already resolved" };
  payout.status = "rejected";
  payout.resolvedAt = Date.now();
  if (note) payout.note = note;
  // Unlock escrowed collateral back to the trader.
  creditUsdc(payout.owner, payout.amount);
  persist(state);
  return { ok: true, payout };
}

export function claimSignupGift(
  owner: string,
  ipHash: string,
  deviceHash: string,
  amount = GIFT_USD,
): { ok: true; amount: number } | { ok: false; error: string; code: "claimed_owner" | "claimed_ip" | "claimed_device" } {
  const state = load();
  const claims = claimsOf(state);
  const denied = giftClaimDenied(claims, owner, ipHash, deviceHash);
  if (denied) return { ok: false, error: denied.error, code: denied.code };
  const acct = getAccount(owner);
  if ((acct.giftUsd ?? 0) > 0) {
    return { ok: false, error: "This wallet already claimed the credit", code: "claimed_owner" };
  }
  acct.deposited += amount;
  acct.giftUsd = amount;
  acct.giftRealized = 0;
  acct.giftClaimedAt = Date.now();
  recordGiftClaim(claims, owner, ipHash, deviceHash, acct.giftClaimedAt);
  persist(state);
  return { ok: true, amount };
}

function pushFill(
  acct: VenueAccount,
  fill: Omit<VenueFill, "id" | "at"> & { at?: number },
) {
  const row: VenueFill = {
    id: `${acct.owner}:${fill.marketId}:${fill.at ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    at: fill.at ?? Date.now(),
    marketId: fill.marketId,
    isLong: fill.isLong,
    size: fill.size,
    price: fill.price,
    pnl: fill.pnl,
    fee: fill.fee && fill.fee > 0 ? fill.fee : undefined,
    reason: fill.reason,
  };
  acct.fills = [row, ...(acct.fills ?? [])].slice(0, 200);
}

export async function applyFill(args: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: number;
  price: number;
  leverage: number;
  reduceOnly: boolean;
  /** Override close reason when TP/SL fires. */
  closeReason?: "tp" | "sl";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { owner, marketId, isLong, size, price, reduceOnly } = args;
  const leverage = Math.max(1, Math.min(args.leverage || 10, 50));
  if (!(size > 0) || !(price > 0)) return { ok: false, error: "Invalid fill" };
  if (isBanned(owner)) return { ok: false, error: bannedError().error };

  const state = load();
  const acct = getAccount(owner);
  const cfg = marketCfg(marketId);
  const maxLev = cfg ? cfg.maxLeverageBps / 10_000 : 10;
  const lev = Math.min(leverage, maxLev);
  const notional = size * price;
  const needMargin = notional / lev;
  const fee = platformFeeUsdc(size, price);

  const existing = acct.positions.find((p) => p.marketId === marketId);
  if (!existing) {
    if (reduceOnly) return { ok: false, error: "No position to reduce" };
    const snap = await snapshot(owner);
    if (snap.freeCollateral + 1e-9 < needMargin + fee) {
      return {
        ok: false,
        error: `Need $${(needMargin + fee).toFixed(2)} free (incl. ${(PLATFORM_FEE_BPS / 100).toFixed(2)}% fee), have $${snap.freeCollateral.toFixed(2)}`,
      };
    }
    acct.positions.push({ marketId, isLong, size, entry: price, margin: needMargin });
    applyPendingTriggers(acct, marketId);
    chargePlatformFee(state, acct, fee);
    pushFill(acct, { marketId, isLong, size, price, pnl: 0, fee, reason: "open" });
    persist(state);
    void flushProtocolFees();
    return { ok: true };
  }

  if (existing.isLong === isLong) {
    if (reduceOnly) return { ok: false, error: "Reduce-only would increase" };
    const snap = await snapshot(owner);
    if (snap.freeCollateral + 1e-9 < needMargin + fee) {
      return {
        ok: false,
        error: `Need $${(needMargin + fee).toFixed(2)} free (incl. fee), have $${snap.freeCollateral.toFixed(2)}`,
      };
    }
    const next = existing.size + size;
    existing.entry = (existing.entry * existing.size + price * size) / next;
    existing.size = next;
    existing.margin += needMargin;
    applyPendingTriggers(acct, marketId);
    chargePlatformFee(state, acct, fee);
    pushFill(acct, { marketId, isLong, size, price, pnl: 0, fee, reason: "add" });
    persist(state);
    void flushProtocolFees();
    return { ok: true };
  }

  const closed = Math.min(existing.size, size);
  const closeFee = platformFeeUsdc(closed, price);
  const used = acct.positions.reduce((s, p) => s + p.margin, 0);
  const freeBefore = accountEquity(acct) - used;
  if (freeBefore + existing.margin * (closed / existing.size) + 1e-9 < closeFee) {
    return { ok: false, error: `Insufficient balance for ${(PLATFORM_FEE_BPS / 100).toFixed(2)}% close fee` };
  }
  const dir = existing.isLong ? 1 : -1;
  const pnl = (price - existing.entry) * closed * dir;
  acct.realized += pnl;
  if ((acct.giftUsd ?? 0) > 0) acct.giftRealized = (acct.giftRealized ?? 0) + pnl;
  chargePlatformFee(state, acct, closeFee);
  pushFill(acct, {
    marketId,
    isLong: existing.isLong,
    size: closed,
    price,
    pnl,
    fee: closeFee,
    reason: args.closeReason ?? "close",
  });
  const remain = existing.size - closed;
  if (remain <= 1e-12) {
    acct.positions = acct.positions.filter((p) => p !== existing);
  } else {
    existing.margin *= remain / existing.size;
    existing.size = remain;
  }
  const leftover = size - closed;
  persist(state);
  void flushProtocolFees();
  if (leftover > 1e-12) {
    if (reduceOnly) return { ok: true };
    return applyFill({ ...args, size: leftover });
  }
  return { ok: true };
}

function applyPendingTriggers(acct: VenueAccount, marketId: number) {
  const pending = acct.pendingTpSl?.[String(marketId)];
  const pos = acct.positions.find((p) => p.marketId === marketId);
  if (!pos) return;
  if (!pending) {
    pos.tp = null;
    pos.sl = null;
    return;
  }
  // Explicit null/0 clears a previous TP/SL so unchecked desk orders stay open.
  pos.tp = pending.tp && pending.tp > 0 ? pending.tp : null;
  pos.sl = pending.sl && pending.sl > 0 ? pending.sl : null;
}

export function setTriggers(
  owner: string,
  marketId: number,
  tp?: number | null,
  sl?: number | null,
) {
  const state = load();
  const acct = getAccount(owner);
  acct.pendingTpSl = acct.pendingTpSl ?? {};
  acct.pendingTpSl[String(marketId)] = {
    tp: tp && tp > 0 ? tp : null,
    sl: sl && sl > 0 ? sl : null,
  };
  applyPendingTriggers(acct, marketId);
  persist(state);
}

/** Close a position if mark has crossed its take-profit or stop-loss. SL wins if both hit. */
export async function checkTriggers(owner: string): Promise<string[]> {
  const acct = getAccount(owner);
  const fired: string[] = [];
  for (const p of [...acct.positions]) {
    const mark = (await fetchMarkUsd(p.marketId)) ?? p.entry;
    const hitSl = Boolean(p.sl && p.sl > 0 && (p.isLong ? mark <= p.sl : mark >= p.sl));
    const hitTp = Boolean(p.tp && p.tp > 0 && (p.isLong ? mark >= p.tp : mark <= p.tp));
    if (!hitSl && !hitTp) continue;
    const px = hitSl ? (p.sl as number) : (p.tp as number);
    const applied = await applyFill({
      owner,
      marketId: p.marketId,
      isLong: !p.isLong,
      size: p.size,
      price: px,
      leverage: 1,
      reduceOnly: true,
      closeReason: hitSl ? "sl" : "tp",
    });
    if (applied.ok) fired.push(hitSl ? "Stop loss filled" : "Take profit filled");
  }
  return fired;
}
