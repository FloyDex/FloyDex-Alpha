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
  bpsToPct,
  compactStakeQty,
  feeBpsForBalances,
  formatStakeQty,
  formatUnlock,
  isOpenStake,
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
  const [amountStr, setAmountStr] = useState("100000");
  const amount = parseAmount(amountStr);
  const term = STAKE_TERMS.find((t) => t.days === days) ?? STAKE_TERMS[1];

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
      toast.success(`Locked ${formatStakeQty(amount, 0)} $FLOYDEX for ${term.days} days`);
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
      toast.success("Principal sent back to your wallet");
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
      <main className="mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">$FLOYDEX</h1>
            <p className="mt-1 max-w-[640px] text-[13px] text-[#6b7c74]">
              Hold $FLOYDEX in your wallet and the desk fee drops. Lock it here and the fee drops further.
              The lock returns the same tokens at the end of the term. It does not mint a yield.
            </p>
          </div>
          <p className="font-mono text-[12px] tabular text-[#14F195]">
            Your fee {bpsToPct(feeBps)}%
          </p>
        </div>

        <section className="grid gap-3 md:grid-cols-3">
          <InfoCard
            label="Your fee"
            value={`${bpsToPct(feeBps)}%`}
            hint={`Standard is ${bpsToPct(data?.baseFeeBps ?? 100)}%. After this lock: ${bpsToPct(previewBps)}%.`}
          />
          <InfoCard
            label="In wallet"
            value={compactStakeQty(wallet)}
            hint={connected ? "Unstaked $FLOYDEX" : "Connect to read your balance"}
          />
          <InfoCard
            label="Locked"
            value={compactStakeQty(staked)}
            hint={`${compactStakeQty(data?.totalStaked ?? 0)} locked by everyone`}
          />
        </section>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="border-b border-[#15221E] px-4 py-3 sm:px-5">
            <h2 className="text-[13px] font-semibold">Tokenomics</h2>
          </div>
          <div className="grid gap-px bg-[#15221E] sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Supply" value={`${STAKE_SUPPLY.toLocaleString("en-US")} $FLOYDEX`} />
            <Fact label="Mint" value={shortenAddress(FLOYDEX_TOKEN.mint)} />
            <Fact label="Launch" value="pump.fun · 29 Sep 2026" />
            <Fact label="Allocation" value="100% bonding curve" />
          </div>
          <p className="px-4 py-3 text-[12px] leading-relaxed text-[#6b7c74] sm:px-5">
            Fixed supply, 6 decimals. There is no team or investor wallet on this mint. Trading the desk
            still settles in USDC. $FLOYDEX only changes the fee you pay.
          </p>
          <div className="flex flex-wrap gap-3 border-t border-[#15221E] px-4 py-3 text-[12px] sm:px-5">
            <a className="text-[#14F195] hover:underline" href={FLOYDEX_TOKEN.clawpump} target="_blank" rel="noopener noreferrer">ClawPump</a>
            <a className="text-[#14F195] hover:underline" href={FLOYDEX_TOKEN.dexscreener} target="_blank" rel="noopener noreferrer">DexScreener</a>
            <a className="text-[#14F195] hover:underline" href={FLOYDEX_TOKEN.padre} target="_blank" rel="noopener noreferrer">Padre</a>
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <TierTable title="Hold in wallet" rows={HOLD_FEE_TIERS} active={wallet} />
          <TierTable title="Lock on this page" rows={STAKE_FEE_TIERS} active={staked} />
        </section>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C]">
          <div className="flex flex-col gap-2.5 border-b border-[#15221E] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap" role="tablist" aria-label="Stake term">
              {STAKE_TERMS.map((t) => (
                <button
                  key={t.days}
                  type="button"
                  role="tab"
                  aria-selected={term.days === t.days}
                  onClick={() => setDays(t.days)}
                  className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${term.days === t.days ? "is-on" : ""}`}
                >
                  {t.days}D
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                aria-label="Stake amount"
                className="h-9 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 font-mono text-[13px] text-[#f5f5f5] outline-none focus:border-[#2A4A40] sm:w-[180px]"
              />
              {[0.25, 0.5, 1].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setPct(pct)}
                  className="h-8 shrink-0 rounded-[8px] border border-[#1C332C] px-2.5 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                >
                  {pct === 1 ? "Max" : `${pct * 100}%`}
                </button>
              ))}
              <button
                type="button"
                onClick={onLock}
                disabled={lock.isPending}
                className="h-8 shrink-0 rounded-[8px] bg-[#14F195] px-3 text-[12px] font-semibold text-[#050807] hover:bg-[#3DFFB0] disabled:opacity-50"
              >
                {!connected ? "Connect" : lock.isPending ? "Locking…" : "Lock"}
              </button>
            </div>
          </div>
          <p className="px-4 py-3 text-[12px] text-[#6b7c74]">
            Locking sends $FLOYDEX to the desk treasury for {term.days} days. You get the same amount back
            after that. While it is locked your fee follows the stake column
            {amount >= 1 ? ` (${bpsToPct(previewBps)}% if you lock ${formatStakeQty(amount, 0)} now)` : ""}.
          </p>
        </section>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex items-center justify-between border-b border-[#15221E] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Your locks</h2>
            <span className="text-[12px] text-[#6b7c74]">
              {open.length} in term · {mine.length} total
            </span>
          </div>
          {!connected ? (
            <p className="px-4 py-14 text-center text-[13px] text-[#6b7c74]">Connect a wallet to lock $FLOYDEX.</p>
          ) : mine.length === 0 ? (
            <p className="px-4 py-14 text-center text-[13px] text-[#6b7c74]">
              No locks yet. Holding still discounts the fee once you cross a tier.
            </p>
          ) : (
            mine.map((row) => {
              const inTerm = isOpenStake(row);
              const ready = !row.returned && Date.now() >= row.unlockAt;
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-[#15221E] px-4 py-3 last:border-b-0"
                >
                  <div>
                    <div className="text-[13px] font-semibold">
                      {formatStakeQty(row.principal, 0)} $FLOYDEX · {row.days} days
                    </div>
                    <div className="mt-0.5 font-mono text-[12px] text-[#6b7c74]">
                      {row.returned
                        ? "Returned"
                        : inTerm
                          ? `Unlocks ${formatUnlock(row.unlockAt)}`
                          : "Ready to unlock"}
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

        <section className="rounded-[12px] border border-[#1C332C] px-4 py-4 text-[13px] leading-relaxed text-[#8A9B94] sm:px-5">
          <h2 className="text-[13px] font-semibold text-[#f5f5f5]">What the token does</h2>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Hold 100,000 or more and the 1.00% taker fee becomes 0.80%. 1,000,000 is 0.60%. 10,000,000 is 0.40%.</li>
            <li>Lock 100,000 or more and the fee becomes 0.50%. Lock 1,000,000 or more and it becomes 0.25%.</li>
            <li>The desk uses the lower of those two fees. You do not stack them on the same tokens.</li>
            <li>You can trade with USDC and no $FLOYDEX. The token is not required, and it is not the settlement asset.</li>
            <li>Buybacks, insurance backstop, and listing votes stay off until the desk has real volume.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function InfoCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[12px] border border-[#1C332C] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</div>
      <div className="mt-1 font-mono text-[28px] font-semibold tabular">{value}</div>
      <div className="mt-1 text-[12px] text-[#6b7c74]">{hint}</div>
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
    <section className="overflow-hidden rounded-[12px] border border-[#1C332C]">
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
