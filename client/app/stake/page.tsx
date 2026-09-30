"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { toast } from "sonner";
import { TopNav } from "@/components/common/TopNav";
import { FLOYDEX_TOKEN } from "@/config/token";
import { apiFetch } from "@/lib/api";
import { shortenAddress } from "@/lib/format";
import { transferFloydexToTreasury } from "@/lib/solana/floydex-stake";
import {
  HOLD_FEE_TIERS,
  STAKE_FEE_TIERS,
  STAKE_SUPPLY,
  STAKE_TERMS,
  STAKE_TREASURY,
  bpsToPct,
  compactStakeQty,
  feeBpsForBalances,
  formatApy,
  formatStakeQty,
  formatUnlock,
  isOpenStake,
  positionPayout,
  positionReward,
  stakePayout,
  stakeReward,
  type StakePosition,
  type StakeTerm,
} from "@/lib/market/stake";
import { useWalletStore } from "@/stores/wallet";

type StakeSnap = {
  totalStaked: number;
  lastStaker: string | null;
  terms: StakeTerm[];
  stakes: StakePosition[];
  openCount: number;
  walletBalance: number;
  staked: number;
  feeBps: number;
  baseFeeBps: number;
  treasury?: string;
};

function parseAmount(raw: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default function StakePage() {
  const { address, connected } = useWalletStore();
  const { sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [amountStr, setAmountStr] = useState("1000");
  const amount = parseAmount(amountStr);
  const term = STAKE_TERMS.find((t) => t.days === days) ?? STAKE_TERMS[1];
  const reward = stakeReward(amount, term.apyPct);
  const payout = stakePayout(amount, term.apyPct);
  const unlockAt = useMemo(() => Date.now() + term.days * 86_400_000, [term.days]);

  const { data } = useQuery({
    queryKey: ["stake", address],
    queryFn: async () => {
      const q = address ? `?owner=${encodeURIComponent(address)}` : "";
      const res = await apiFetch(`/api/stake${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error("stake");
      return (await res.json()) as StakeSnap;
    },
    refetchInterval: 15_000,
  });

  const wallet = data?.walletBalance ?? 0;
  const staked = data?.staked ?? 0;
  const feeBps = data?.feeBps ?? feeBpsForBalances(wallet, staked);
  const previewBps = useMemo(
    () => feeBpsForBalances(Math.max(0, wallet - amount), staked + amount),
    [wallet, staked, amount],
  );
  const treasury = data?.treasury || STAKE_TREASURY;

  const lock = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect a wallet");
      const signature = await transferFloydexToTreasury(address, amount, sendTransaction);
      let lastErr = "Transfer landed but the desk has not recorded the lock yet";
      for (let i = 0; i < 8; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 800));
        const res = await apiFetch("/api/stake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: address, days: term.days, amount, signature }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && json.ok) return json;
        lastErr = json.error || lastErr;
        if (res.status !== 409) break;
      }
      throw new Error(lastErr);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stake", address] });
      toast.success(
        `Locked ${formatStakeQty(amount, 0)} $FLOYDEX · ${formatStakeQty(payout, 0)} at unlock`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unlock = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch("/api/stake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlock", owner: address, id }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "Could not unlock");
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stake", address] });
      toast.success("Principal + reward sent back to your wallet");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mine = data?.stakes ?? [];
  const open = mine.filter((r) => isOpenStake(r));

  function setPct(pct: number) {
    const next = Math.floor(wallet * pct);
    setAmountStr(String(Math.max(0, next)));
  }

  function onLock() {
    if (!connected || !address) {
      setVisible(true);
      return;
    }
    if (!(amount >= 1)) {
      toast.error("Enter an amount of at least 1");
      return;
    }
    if (amount > wallet + 1e-6) {
      toast.error("Amount is above your $FLOYDEX balance");
      return;
    }
    lock.mutate();
  }

  return (
    <div
      className="min-h-screen bg-[#070B0A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-[820px]">
            <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-[#6b7c74]">
              $FLOYDEX staking
            </p>
            <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.02em] sm:text-[34px]">
              Lock $FLOYDEX. Pick a term.
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-[#6b7c74]">
              {STAKE_TERMS.map((t, i) => (
                <span key={t.days}>
                  {i > 0 ? ", " : null}
                  {t.days} days {formatApy(t.apyPct)}%{i === 0 ? " APY" : ""}
                </span>
              ))}
              . Send $FLOYDEX from your wallet. You receive principal + reward at unlock. A locked stake
              also cuts the desk fee (now {bpsToPct(feeBps)}%
              {amount >= 1 ? ` → ${bpsToPct(previewBps)}% after this lock` : ""}).
            </p>
          </div>
          <a
            className="font-mono text-[13px] text-[#14F195] underline-offset-2 hover:underline"
            href={`https://solscan.io/account/${treasury}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortenAddress(treasury)}
          </a>
        </header>

        <section className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="rounded-[14px] border border-[#1C332C] px-5 py-4">
            <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">Total staked</div>
            <div className="mt-1 font-mono text-[36px] font-semibold tabular leading-none">
              {compactStakeQty(data?.totalStaked ?? 0)}
            </div>
            <div className="mt-2 text-[12px] text-[#6b7c74]">
              $FLOYDEX locked by everyone
              {data?.lastStaker ? ` · last ${data.lastStaker}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="h-9 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold leading-9 text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              href={FLOYDEX_TOKEN.dexscreener}
              target="_blank"
              rel="noopener noreferrer"
            >
              DexScreener
            </a>
            <a
              className="h-9 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold leading-9 text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              href={FLOYDEX_TOKEN.padre}
              target="_blank"
              rel="noopener noreferrer"
            >
              Padre
            </a>
          </div>
        </section>

        <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
          <div className="flex flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {STAKE_TERMS.map((t) => {
                const on = t.days === term.days;
                const atUnlock = stakePayout(amount > 0 ? amount : 1000, t.apyPct);
                return (
                  <button
                    key={t.days}
                    type="button"
                    onClick={() => setDays(t.days)}
                    className={`rounded-[14px] border px-3 py-3 text-left transition-colors ${
                      on
                        ? "border-[#14F195] bg-[#14F195]/[0.08]"
                        : "border-[#1C332C] hover:border-[#2A4A40]"
                    }`}
                  >
                    <div className="text-[13px] font-semibold">{t.days} days</div>
                    <div className={`mt-1 font-mono text-[18px] font-semibold ${on ? "text-[#14F195]" : ""}`}>
                      {formatApy(t.apyPct)}% <span className="text-[12px] font-semibold text-[#6b7c74]">APY</span>
                    </div>
                    <div className="mt-2 font-mono text-[12px] text-[#8A9B94]">
                      {formatStakeQty(atUnlock, 0)} at unlock
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="rounded-[14px] border border-[#1C332C] px-4 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <label className="block min-w-[200px] flex-1">
                  <span className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">Amount</span>
                  <input
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))}
                    inputMode="decimal"
                    aria-label="Stake amount"
                    className="mt-1.5 h-11 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 font-mono text-[16px] text-[#f5f5f5] outline-none focus:border-[#2A4A40]"
                  />
                </label>
                <div className="flex gap-1.5">
                  {[0.25, 0.5, 1].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => setPct(pct)}
                      disabled={!connected || wallet <= 0}
                      className="h-11 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5] disabled:opacity-40"
                    >
                      {pct === 1 ? "Max" : `${pct * 100}%`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[14px] border border-[#1C332C]">
              <div className="border-b border-[#15221E] px-4 py-3 text-[13px] font-semibold">
                Staking calculator for every term
              </div>
              <div className="hidden grid-cols-[1fr_0.7fr_0.9fr_1fr] gap-2 border-b border-[#15221E] px-4 py-2 text-[11px] uppercase tracking-[.06em] text-[#6b7c74] sm:grid">
                <span>Term</span>
                <span>APY</span>
                <span>Reward</span>
                <span className="text-right">You receive</span>
              </div>
              {STAKE_TERMS.map((t) => {
                const on = t.days === term.days;
                const r = stakeReward(amount > 0 ? amount : 0, t.apyPct);
                const out = stakePayout(amount > 0 ? amount : 0, t.apyPct);
                return (
                  <button
                    key={t.days}
                    type="button"
                    onClick={() => setDays(t.days)}
                    className={`grid w-full grid-cols-2 gap-2 border-b border-[#15221E] px-4 py-3 text-left text-[13px] last:border-b-0 sm:grid-cols-[1fr_0.7fr_0.9fr_1fr] ${
                      on ? "bg-[#14F195]/[0.06]" : "hover:bg-white/[0.02]"
                    }`}
                  >
                    <span className="font-semibold">{t.days} days</span>
                    <span className={`font-mono ${on ? "text-[#14F195]" : ""}`}>{formatApy(t.apyPct)}%</span>
                    <span className="font-mono text-[#8A9B94]">
                      {amount > 0 ? `+${formatStakeQty(r, 0)}` : "—"}
                    </span>
                    <span className={`font-mono sm:text-right ${on ? "text-[#14F195]" : ""}`}>
                      {amount > 0 ? formatStakeQty(out, 0) : "—"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="rounded-[14px] border border-[#1C332C] px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">Ticket</div>
                  <div className="mt-1 text-[15px] font-semibold">
                    {term.days} days · {formatApy(term.apyPct)}% APY
                  </div>
                  <div className="mt-3 text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">You receive</div>
                  <div className="mt-1 font-mono text-[32px] font-semibold tabular leading-none text-[#14F195]">
                    {amount > 0 ? formatStakeQty(payout, 0) : "—"}
                  </div>
                  <div className="mt-1 text-[13px] text-[#8A9B94]">
                    {amount > 0 ? `+${formatStakeQty(reward, 0)} reward` : "Enter an amount"}
                  </div>
                </div>
                <div className="text-left sm:text-right">
                  <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">Unlocks</div>
                  <div className="mt-1 font-mono text-[13px] text-[#c5d4cc]">{formatUnlock(unlockAt)}</div>
                  <div className="mt-1 text-[12px] text-[#6b7c74]">Principal + reward land at unlock.</div>
                  <div className="mt-3 text-[12px] text-[#6b7c74]">
                    Sends $FLOYDEX to{" "}
                    <a
                      className="text-[#14F195] hover:underline"
                      href={`https://solscan.io/account/${treasury}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortenAddress(treasury)}
                    </a>
                    .
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onLock}
                disabled={lock.isPending}
                className="mt-4 h-11 w-full rounded-[10px] bg-[#14F195] text-[13px] font-semibold text-[#050807] hover:bg-[#3DFFB0] disabled:opacity-50"
              >
                {!connected
                  ? "Connect to lock"
                  : lock.isPending
                    ? "Locking…"
                    : `Lock ${amount > 0 ? formatStakeQty(amount, 0) : ""} $FLOYDEX`.trim()}
              </button>
            </div>

            <section className="overflow-hidden rounded-[14px] border border-[#1C332C]">
              <div className="flex items-center justify-between border-b border-[#15221E] px-4 py-3">
                <h2 className="text-[13px] font-semibold">Your locks</h2>
                <span className="text-[12px] text-[#6b7c74]">
                  {open.length} in term · {mine.length} total
                </span>
              </div>
              {!connected ? (
                <p className="px-4 py-10 text-center text-[13px] text-[#6b7c74]">
                  Connect a wallet to see locks and unlock times.
                </p>
              ) : mine.length === 0 ? (
                <p className="px-4 py-10 text-center text-[13px] text-[#6b7c74]">
                  No locks yet. Pick a term and lock $FLOYDEX to earn the period yield.
                </p>
              ) : (
                mine.map((row) => {
                  const inTerm = isOpenStake(row);
                  const ready = !row.returned && Date.now() >= row.unlockAt;
                  const rowReward = positionReward(row);
                  const rowPayout = positionPayout(row);
                  return (
                    <div
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-[#15221E] px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="text-[13px] font-semibold">
                          {formatStakeQty(row.principal, 0)} → {formatStakeQty(rowPayout, 0)} · {row.days}D
                        </div>
                        <div className="mt-0.5 font-mono text-[12px] text-[#6b7c74]">
                          {row.returned
                            ? "Returned"
                            : inTerm
                              ? `+${formatStakeQty(rowReward, 0)} · unlocks ${formatUnlock(row.unlockAt)}`
                              : `+${formatStakeQty(rowReward, 0)} · ready to unlock`}
                        </div>
                      </div>
                      {ready ? (
                        <button
                          type="button"
                          onClick={() => unlock.mutate(row.id)}
                          disabled={unlock.isPending}
                          className="h-8 rounded-[8px] border border-[#14F195] px-3 text-[12px] font-semibold text-[#14F195] hover:bg-[#14F195]/10 disabled:opacity-50"
                        >
                          Unlock
                        </button>
                      ) : (
                        <span className="font-mono text-[12px] text-[#6b7c74]">
                          {row.returned ? "Done" : "Locked"}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          </div>

          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-[14px] border border-[#1C332C] bg-[#050807]">
              <div className="flex items-center justify-between gap-3 border-b border-[#15221E] px-4 py-2.5">
                <h2 className="text-[13px] font-semibold">$FLOYDEX chart</h2>
                <a
                  className="text-[11px] font-semibold text-[#14F195] hover:underline"
                  href={FLOYDEX_TOKEN.dexscreener}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open DexScreener ↗
                </a>
              </div>
              <div id="dexscreener-embed" className="relative w-full pb-[125%] min-[1400px]:pb-[110%]">
                <iframe
                  title="$FLOYDEX DexScreener chart"
                  src={FLOYDEX_TOKEN.dexscreenerEmbed}
                  className="absolute inset-0 h-full w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  allow="clipboard-write; fullscreen"
                />
              </div>
            </div>

            <div className="grid gap-3">
              <TierTable title="Hold in wallet" rows={HOLD_FEE_TIERS} active={wallet} />
              <TierTable title="Lock on this page" rows={STAKE_FEE_TIERS} active={staked} />
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-[14px] border border-[#1C332C]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#15221E] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Tokenomics</h2>
            <p className="font-mono text-[11px] text-[#6b7c74]">{shortenAddress(FLOYDEX_TOKEN.mint)}</p>
          </div>
          <div className="grid gap-px bg-[#15221E] sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Supply" value={`${STAKE_SUPPLY.toLocaleString("en-US")}`} />
            <Fact label="Stake wallet" value={shortenAddress(treasury)} />
            <Fact label="Launch" value="pump.fun · 29 Sep 2026" />
            <Fact label="Allocation" value="100% bonding curve" />
          </div>
        </section>
      </main>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#070B0A] px-4 py-3">
      <div className="text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</div>
      <div className="mt-1 font-mono text-[13px] text-[#f5f5f5]">{value}</div>
    </div>
  );
}

function TierTable({
  title,
  rows,
  active,
}: {
  title: string;
  rows: readonly { minTokens: number; bps: number }[];
  active: number;
}) {
  const sorted = [...rows].sort((a, b) => a.minTokens - b.minTokens);
  return (
    <section className="overflow-hidden rounded-[14px] border border-[#1C332C]">
      <div className="border-b border-[#15221E] px-4 py-3 text-[13px] font-semibold">{title}</div>
      {sorted.map((row) => {
        const on = active + 1e-9 >= row.minTokens && (row.minTokens > 0 || active <= 0);
        const matched =
          [...sorted].reverse().find((t) => active + 1e-9 >= t.minTokens)?.minTokens === row.minTokens;
        return (
          <div
            key={row.minTokens}
            className={`flex items-center justify-between border-b border-[#15221E] px-4 py-2.5 text-[13px] last:border-b-0 ${matched ? "bg-[#14F195]/[0.06]" : ""}`}
          >
            <span className="text-[#c5d4cc]">
              {row.minTokens === 0 ? "Below 100,000" : `${compactStakeQty(row.minTokens)}+`}
            </span>
            <span className={`font-mono tabular ${on && matched ? "text-[#14F195]" : "text-[#f5f5f5]"}`}>
              {bpsToPct(row.bps)}%
            </span>
          </div>
        );
      })}
    </section>
  );
}
