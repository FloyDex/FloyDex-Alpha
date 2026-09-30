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
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[26px]">$FLOYDEX</h1>
              <span className="rounded-full border border-[#14F195]/35 bg-[#14F195]/[0.08] px-2.5 py-0.5 font-mono text-[11px] text-[#14F195]">
                Fee utility
              </span>
            </div>
            <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-[#6b7c74]">
              Hold in wallet for a lower desk fee. Lock here for a deeper cut. Same tokens back at unlock —
              no minted yield. Desk still settles in USDC.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="h-8 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              href={FLOYDEX_TOKEN.clawpump}
              target="_blank"
              rel="noopener noreferrer"
            >
              ClawPump
            </a>
            <a
              className="h-8 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              href={FLOYDEX_TOKEN.dexscreener}
              target="_blank"
              rel="noopener noreferrer"
            >
              DexScreener
            </a>
            <a
              className="h-8 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              href={FLOYDEX_TOKEN.padre}
              target="_blank"
              rel="noopener noreferrer"
            >
              Padre
            </a>
            <div className="h-8 rounded-[8px] border border-[#14F195]/40 bg-[#14F195]/[0.08] px-3 font-mono text-[12px] leading-8 text-[#14F195]">
              Your fee {bpsToPct(feeBps)}%
            </div>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          <InfoCard
            label="Your fee"
            value={`${bpsToPct(feeBps)}%`}
            hint={`Standard ${bpsToPct(data?.baseFeeBps ?? 100)}% · after this lock ${bpsToPct(previewBps)}%`}
            accent
          />
          <InfoCard
            label="In wallet"
            value={compactStakeQty(wallet)}
            hint={connected ? "Unstaked $FLOYDEX" : "Connect to read balance"}
          />
          <InfoCard
            label="Locked"
            value={compactStakeQty(staked)}
            hint={`${compactStakeQty(data?.totalStaked ?? 0)} locked by everyone`}
          />
        </section>

        {/* Chart + lock — primary workspace */}
        <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#050807]">
            <div className="flex items-center justify-between gap-3 border-b border-[#15221E] px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Live chart</h2>
              <a
                className="text-[11px] font-semibold text-[#14F195] hover:underline"
                href={FLOYDEX_TOKEN.dexscreener}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open DexScreener ↗
              </a>
            </div>
            <div
              id="dexscreener-embed"
              className="relative w-full pb-[125%] min-[1400px]:pb-[65%]"
            >
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

          <div className="flex flex-col gap-3">
            <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
              <div className="border-b border-[#15221E] px-4 py-3">
                <h2 className="text-[13px] font-semibold">Lock $FLOYDEX</h2>
                <p className="mt-1 text-[12px] text-[#6b7c74]">
                  Tokens go to the desk treasury for the term, then return 1:1.
                </p>
              </div>

              <div className="space-y-3 px-4 py-3">
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">Term</div>
                  <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Stake term">
                    {STAKE_TERMS.map((t) => (
                      <button
                        key={t.days}
                        type="button"
                        role="tab"
                        aria-selected={term.days === t.days}
                        onClick={() => setDays(t.days)}
                        className={`h-9 min-w-[52px] rounded-[8px] border px-2.5 text-[12px] font-semibold transition-colors ${
                          term.days === t.days
                            ? "border-[#14F195] bg-[#14F195]/[0.12] text-[#14F195]"
                            : "border-[#1C332C] text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                        }`}
                      >
                        {t.days}D
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">Amount</span>
                    <span className="font-mono text-[11px] text-[#6b7c74]">
                      Wallet {compactStakeQty(wallet)}
                    </span>
                  </div>
                  <input
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))}
                    inputMode="decimal"
                    aria-label="Stake amount"
                    className="h-11 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 font-mono text-[15px] text-[#f5f5f5] outline-none focus:border-[#2A4A40]"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[0.25, 0.5, 1].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setPct(pct)}
                        className="h-8 rounded-[8px] border border-[#1C332C] px-2.5 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                      >
                        {pct === 1 ? "Max" : `${pct * 100}%`}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAmountStr("100000")}
                      className="h-8 rounded-[8px] border border-[#1C332C] px-2.5 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                    >
                      100k
                    </button>
                  </div>
                </div>

                <div className="rounded-[8px] border border-[#15221E] bg-[#0A100E] px-3 py-2.5 text-[12px] text-[#6b7c74]">
                  Locking for <span className="text-[#c5d4cc]">{term.days} days</span>
                  {amount >= 1 ? (
                    <>
                      {" "}
                      · fee becomes{" "}
                      <span className="font-mono text-[#14F195]">{bpsToPct(previewBps)}%</span>
                    </>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={onLock}
                  disabled={lock.isPending}
                  className="h-11 w-full rounded-[8px] bg-[#14F195] text-[13px] font-semibold text-[#050807] hover:bg-[#3DFFB0] disabled:opacity-50"
                >
                  {!connected ? "Connect wallet" : lock.isPending ? "Locking…" : `Lock for ${term.days}D`}
                </button>
              </div>
            </section>

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
              <div className="flex items-center justify-between border-b border-[#15221E] px-4 py-3">
                <h2 className="text-[13px] font-semibold">Your locks</h2>
                <span className="text-[12px] text-[#6b7c74]">
                  {open.length} in term · {mine.length} total
                </span>
              </div>
              <div className="max-h-[280px] overflow-y-auto xl:max-h-none xl:flex-1">
                {!connected ? (
                  <EmptyLocks
                    title="Connect to lock"
                    body="Wallet balance drives hold tiers. Locks unlock deeper fee cuts."
                    actionLabel="Connect wallet"
                    onAction={() => setVisible(true)}
                  />
                ) : mine.length === 0 ? (
                  <EmptyLocks
                    title="No locks yet"
                    body="Holding still discounts the fee once you cross a tier. Lock 100k+ for 0.50%."
                    actionLabel="Use 100k"
                    onAction={() => setAmountStr("100000")}
                  />
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
                            {formatStakeQty(row.principal, 0)} $FLOYDEX · {row.days}D
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
              </div>
            </section>
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <TierTable title="Hold in wallet" rows={HOLD_FEE_TIERS} active={wallet} />
          <TierTable title="Lock on this page" rows={STAKE_FEE_TIERS} active={staked} />
        </section>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#15221E] px-4 py-3 sm:px-5">
            <h2 className="text-[13px] font-semibold">Tokenomics</h2>
            <p className="font-mono text-[11px] text-[#6b7c74]">{shortenAddress(FLOYDEX_TOKEN.mint)}</p>
          </div>
          <div className="grid gap-px bg-[#15221E] sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Supply" value={`${STAKE_SUPPLY.toLocaleString("en-US")}`} />
            <Fact label="Decimals" value={`${FLOYDEX_TOKEN.decimals}`} />
            <Fact label="Launch" value="pump.fun · 29 Sep 2026" />
            <Fact label="Allocation" value="100% bonding curve" />
          </div>
          <p className="px-4 py-3 text-[12px] leading-relaxed text-[#6b7c74] sm:px-5">
            Fixed supply. No team or investor wallet on this mint. $FLOYDEX only changes the fee you pay —
            it is not the settlement asset.
          </p>
        </section>

        <section className="rounded-[12px] border border-[#1C332C] px-4 py-4 text-[13px] leading-relaxed text-[#8A9B94] sm:px-5">
          <h2 className="text-[13px] font-semibold text-[#f5f5f5]">How fees work</h2>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <li className="rounded-[8px] border border-[#15221E] bg-[#0A100E] px-3 py-2.5 text-[12px] leading-relaxed">
              Hold 100k → 0.80%. 1M → 0.60%. 10M → 0.40%.
            </li>
            <li className="rounded-[8px] border border-[#15221E] bg-[#0A100E] px-3 py-2.5 text-[12px] leading-relaxed">
              Lock 100k → 0.50%. Lock 1M → 0.25%.
            </li>
            <li className="rounded-[8px] border border-[#15221E] bg-[#0A100E] px-3 py-2.5 text-[12px] leading-relaxed">
              Desk uses the lower of hold vs lock. Same tokens are not stacked twice.
            </li>
            <li className="rounded-[8px] border border-[#15221E] bg-[#0A100E] px-3 py-2.5 text-[12px] leading-relaxed">
              Trading needs USDC only. $FLOYDEX is optional fee utility.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function InfoCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-[12px] border px-4 py-3.5 ${
        accent ? "border-[#14F195]/30 bg-[#14F195]/[0.04]" : "border-[#1C332C]"
      }`}
    >
      <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</div>
      <div className={`mt-1 font-mono text-[26px] font-semibold tabular sm:text-[28px] ${accent ? "text-[#14F195]" : ""}`}>
        {value}
      </div>
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

function EmptyLocks({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-8">
      <div>
        <div className="text-[13px] font-semibold text-[#c5d4cc]">{title}</div>
        <p className="mt-1 max-w-[320px] text-[12px] leading-relaxed text-[#6b7c74]">{body}</p>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="h-8 rounded-[8px] border border-[#1C332C] px-3 text-[12px] font-semibold text-[#8A9B94] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
      >
        {actionLabel}
      </button>
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
