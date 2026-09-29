"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { toast } from "sonner";
import { TopNav } from "@/components/common/TopNav";
import { PLATFORM_FEE_BPS } from "@/config";
import { apiFetch } from "@/lib/api";
import { shortenAddress } from "@/lib/format";
import {
  STAKE_FEE_BPS,
  STAKE_PUBLIC,
  STAKE_TERMS,
  compactStakeQty,
  formatApy,
  formatStakeQty,
  formatUnlock,
  isOpenStake,
  quoteStake,
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
};

const deskFee = (PLATFORM_FEE_BPS / 100).toFixed(2);
const stakedFee = (STAKE_FEE_BPS / 100).toFixed(2);

const ROW_GRID = "md:grid md:grid-cols-[minmax(120px,1fr)_80px_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-x-4";

function parseAmount(raw: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default function StakePage() {
  const { address, connected } = useWalletStore();
  const { setVisible } = useWalletModal();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [amountStr, setAmountStr] = useState("1000");
  const amount = parseAmount(amountStr);
  const term = STAKE_TERMS.find((t) => t.days === days) ?? STAKE_TERMS[1];
  const quote = useMemo(() => quoteStake(amount, term), [amount, term]);

  const { data } = useQuery({
    queryKey: ["stake", address],
    enabled: STAKE_PUBLIC,
    queryFn: async () => {
      const q = address ? `?owner=${encodeURIComponent(address)}` : "";
      const res = await apiFetch(`/api/stake${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error("stake");
      return (await res.json()) as StakeSnap;
    },
    refetchInterval: 15_000,
  });

  const lock = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/stake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: address, days: term.days, amount }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "Could not lock");
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stake", address] });
      toast.success(`Locked ${formatStakeQty(amount, 0)} for ${term.days} days`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const total = data?.totalStaked ?? 0;
  const mine = data?.stakes ?? [];
  const open = mine.filter((r) => isOpenStake(r));
  const preview = amount > 0 ? amount : 1000;

  function setPct(pct: number) {
    setAmountStr(String(Math.max(1, Math.round(1000 * pct))));
  }

  function onLock() {
    if (!STAKE_PUBLIC) {
      toast.error("Staking is not live yet");
      return;
    }
    if (!connected || !address) {
      setVisible(true);
      return;
    }
    if (!quote) {
      toast.error("Enter an amount of at least 1");
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
            <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">Stake</h1>
            <p className="mt-1 text-[13px] text-[#6b7c74]">
              Lock desk stake for a term. Principal + reward at unlock. Desk fee {deskFee}% → {stakedFee}%.
            </p>
          </div>
          <p className="text-[12px] tabular text-[#6b7c74]">
            {STAKE_PUBLIC ? `${open.length} open locks` : "Not live"}
          </p>
        </div>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#15221E] px-4 py-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-[22px] items-center rounded-[5px] border border-[#1C332C] bg-[#0E1614] px-2 text-[10px] font-semibold uppercase tracking-[.06em] text-[#c5d4cc]">
                stake
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">Term lock</span>
              {connected && address ? (
                <span className="ml-1 truncate font-mono text-[11px] text-[#6b7c74]">{shortenAddress(address)}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onLock}
              disabled={lock.isPending || !STAKE_PUBLIC}
              className="h-8 rounded-[8px] bg-[#14F195] px-3 text-[12px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!STAKE_PUBLIC ? "Not live" : !connected ? "Connect Wallet" : lock.isPending ? "Locking…" : "Lock stake"}
            </button>
          </div>

          <div className="grid gap-0 md:grid-cols-[minmax(240px,0.9fr)_minmax(0,1.1fr)]">
            <div className="border-b border-[#15221E] p-5 md:border-b-0 md:border-r">
              <div className="text-[11px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">Total staked</div>
              <div className="mt-1 font-mono text-[32px] font-semibold leading-none tabular sm:text-[36px]">
                {compactStakeQty(total)}
              </div>
              <div className="mt-2 text-[13px] text-[#6b7c74]">Locked by everyone</div>
              {data?.lastStaker ? (
                <div className="mt-1 font-mono text-[12px] text-[#6b7c74]">{data.lastStaker}</div>
              ) : null}
            </div>
            <div className="p-5">
              <div className="text-[11px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">You receive</div>
              <div className="mt-1 font-mono text-[32px] font-semibold leading-none tabular sm:text-[36px]">
                {quote ? formatStakeQty(quote.receive, 0) : "—"}
              </div>
              <div className={`mt-2 font-mono text-[13px] tabular ${quote ? "text-[#14F195]" : "text-[#6b7c74]"}`}>
                {quote ? `+${formatStakeQty(quote.reward, 0)} reward · ${term.days}d · ${formatApy(term.apy)} APY` : "Enter an amount"}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#15221E] pt-4">
                <HeroStat label="Unlocks" value={quote ? formatUnlock(quote.unlockAt) : "—"} />
                <HeroStat label="Principal" value={quote ? formatStakeQty(quote.principal, 0) : "—"} />
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {STAKE_TERMS.map((t) => {
            const row = quoteStake(preview, t);
            const on = t.days === term.days;
            return (
              <button
                key={t.days}
                type="button"
                onClick={() => setDays(t.days)}
                className={`rounded-[12px] border px-4 py-3 text-left transition-colors ${
                  on ? "border-[#14F195]/50 bg-[#0E1614]" : "border-[#1C332C] bg-[#070B0A] hover:border-[#2A4A40]"
                }`}
              >
                <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">{t.days} days</div>
                <div className={`mt-1 font-mono text-[16px] font-semibold tabular ${on ? "text-[#14F195]" : "text-[#f5f5f5]"}`}>
                  {formatApy(t.apy)}
                </div>
                <div className="mt-1 font-mono text-[11px] tabular text-[#8A9B94]">
                  {row ? formatStakeQty(row.receive, 0) : "—"} at unlock
                </div>
              </button>
            );
          })}
        </div>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
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
              <label className="relative block w-full sm:w-[180px]">
                <span className="sr-only">Amount</span>
                <input
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                  aria-label="Stake amount"
                  className="h-9 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 font-mono text-[13px] text-[#f5f5f5] outline-none placeholder:text-[#5c6b64] focus:border-[#2A4A40]"
                />
              </label>
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
            </div>
          </div>

          <div className="overflow-x-auto">
          <div className={`hidden border-b border-[#15221E] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[#6b7c74] md:grid ${ROW_GRID}`}>
            <span>Term</span>
            <span>APY</span>
            <span className="text-right">Reward</span>
            <span className="text-right">You receive</span>
          </div>

          {STAKE_TERMS.map((t) => {
            const row = quoteStake(preview, t);
            const on = t.days === term.days;
            return (
              <button
                key={t.days}
                type="button"
                onClick={() => setDays(t.days)}
                className={`flex w-full flex-col gap-2 border-b border-[#15221E] px-4 py-3 text-left last:border-b-0 hover:bg-[#0E1614] md:gap-0 ${ROW_GRID} ${on ? "bg-[#14F195]/[0.04]" : ""}`}
              >
                <span className="text-[13px] font-semibold text-[#f5f5f5]">{t.days} days</span>
                <span className="font-mono text-[13px] tabular text-[#d5ddd8]">{formatApy(t.apy)}</span>
                <span className="text-right font-mono text-[13px] tabular text-[#14F195]">
                  {row ? `+${formatStakeQty(row.reward, 0)}` : "—"}
                </span>
                <span className="text-right font-mono text-[13px] tabular text-[#f5f5f5]">
                  {row ? formatStakeQty(row.receive, 0) : "—"}
                </span>
              </button>
            );
          })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#15221E] px-4 py-3">
            <span className="text-[12px] text-[#6b7c74]">
              {STAKE_PUBLIC
                ? "Principal + reward land at unlock."
                : "Staking is not live. Terms are shown for preview only."}
            </span>
            <button
              type="button"
              onClick={onLock}
              disabled={lock.isPending || !STAKE_PUBLIC}
              className="h-8 rounded-[8px] bg-[#14F195] px-3 text-[12px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!STAKE_PUBLIC ? "Not live" : !connected ? "Connect Wallet" : lock.isPending ? "Locking…" : "Lock stake"}
            </button>
          </div>
        </section>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex items-center justify-between border-b border-[#15221E] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Your locks</h2>
            <span className="text-[12px] text-[#6b7c74]">
              {open.length} open · {mine.length} total
            </span>
          </div>
          {!STAKE_PUBLIC ? (
            <p className="px-4 py-14 text-center text-[13px] text-[#6b7c74]">
              Protocol-token locking opens at TGE (ticker TBD). Terms will list here.
            </p>
          ) : !connected ? (
            <p className="px-4 py-14 text-center text-[13px] text-[#6b7c74]">Connect a wallet to book a term.</p>
          ) : mine.length === 0 ? (
            <p className="px-4 py-14 text-center text-[13px] text-[#6b7c74]">
              No locks yet. Pick a term and lock stake.
            </p>
          ) : (
            mine.map((row) => {
              const openRow = isOpenStake(row);
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-[#15221E] px-4 py-3 last:border-b-0"
                >
                  <div>
                    <div className="text-[13px] font-semibold">
                      {row.days} days · {formatApy(row.apy)} APY
                    </div>
                    <div className="mt-0.5 font-mono text-[12px] text-[#6b7c74]">
                      {shortenAddress(row.owner)} · {openRow ? `unlocks ${formatUnlock(row.unlockAt)}` : "unlocked"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[15px] font-semibold tabular">
                      {formatStakeQty(row.receive, 0)}
                    </div>
                    <div className="font-mono text-[12px] tabular text-[#14F195]">+{formatStakeQty(row.reward, 0)}</div>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </main>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</div>
      <div className="mt-1 font-mono text-[13px] tabular text-[#f5f5f5]">{value}</div>
    </div>
  );
}
