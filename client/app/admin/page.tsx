"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FEE_COLLECTOR, MARKETS, PLATFORM_FEE_BPS } from "@/config";
import { formatAccountUsd } from "@/lib/format";
import {
  AdminShell,
  Addr,
  CoverageBar,
  EmptyState,
  LiveDot,
  Section,
  SkeletonCards,
  StatCard,
  WhenCell,
  shortAddr,
} from "@/components/admin/AdminShell";

type Overview = {
  generatedAt: number;
  feeCollector: string;
  platformFeeBps: number;
  vault: {
    fundedIn: number;
    fundedOut: number;
    netPrincipal: number;
    ledgerEquity: number;
    usedMargin: number;
    freeCollateral: number;
  };
  fees: { paid: number; pending: number; sent: number };
  traders: {
    accounts: number;
    withBalance: number;
    withPositions: number;
    openPositions: number;
    giftClaims: number;
    giftOutstanding: number;
  };
  flow24h: {
    volume: number;
    fees: number;
    fills: number;
    deposits: number;
    withdraws: number;
  };
  payouts: { pendingCount: number; pendingUsd: number; total: number };
  markets: Array<{
    marketId: number;
    symbol: string;
    long: number;
    short: number;
    notional: number;
    traders: number;
  }>;
  recentFills: Array<{
    id: string;
    owner: string;
    marketId: number;
    isLong: boolean;
    size: number;
    price: number;
    pnl: number;
    fee?: number;
    reason: string;
    at: number;
  }>;
  recentTransfers: Array<{
    id: string;
    owner: string;
    kind: "deposit" | "withdraw";
    amount: number;
    at: number;
    signature?: string;
  }>;
  treasury: {
    pubkey: string | null;
    usdc: number | null;
    sol: number | null;
    coverRatio: number | null;
  };
};

function symbolFor(marketId: number) {
  return Object.values(MARKETS).find((m) => m.marketId === marketId)?.symbol ?? `M${marketId}`;
}

export default function AdminOverviewPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/overview", { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/admin/login?next=/admin");
      return;
    }
    const json = (await res.json().catch(() => ({}))) as Overview & {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || json.ok === false) {
      setError(json.error ?? "Failed to load desk");
      return;
    }
    setError(null);
    setData(json);
  }, [router]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const feePct = ((data?.platformFeeBps ?? PLATFORM_FEE_BPS) / 100).toFixed(2);
  const cover = data?.treasury.coverRatio;
  const coverTone =
    cover == null ? "default" : cover >= 1 ? "good" : cover >= 0.8 ? "warn" : "bad";

  return (
    <AdminShell
      title="Overview"
      subtitle="Platform-wide vault health, fees, open risk, and recent desk flow."
      trailing={<LiveDot label={data ? `Synced ${new Date(data.generatedAt).toLocaleTimeString()}` : "Syncing"} />}
    >
      {error && (
        <p className="mb-5 rounded-[12px] border border-[#FF5C6A]/25 bg-[#2a1216]/80 px-4 py-3 text-[13px] text-[#FF5C6A]">
          {error}
        </p>
      )}

      {!data ? (
        <div className="space-y-3">
          <SkeletonCards n={4} />
          <SkeletonCards n={4} />
        </div>
      ) : (
        <div className="space-y-8">
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
              Vault & coverage
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-[14px] border border-white/[0.06] bg-[#0E1614]/90 px-4 py-4 sm:col-span-2 lg:col-span-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
                  Treasury USDC
                </div>
                <div className="mt-2 font-mono text-[22px] font-semibold tabular-nums">
                  {data.treasury.usdc == null ? "—" : formatAccountUsd(data.treasury.usdc)}
                </div>
                <div className="mt-2 text-[11px] text-[#6b7c74]">
                  {data.treasury.sol == null
                    ? shortAddr(data.treasury.pubkey ?? "unset")
                    : `${data.treasury.sol.toFixed(4)} SOL · ${shortAddr(data.treasury.pubkey ?? "")}`}
                </div>
              </div>
              <StatCard
                label="Ledger equity"
                value={formatAccountUsd(data.vault.ledgerEquity)}
                hint={`Used ${formatAccountUsd(data.vault.usedMargin)} · free ${formatAccountUsd(data.vault.freeCollateral)}`}
              />
              <div
                className={`rounded-[14px] border px-4 py-4 ${
                  coverTone === "good"
                    ? "border-[#14F195]/20"
                    : coverTone === "warn"
                      ? "border-amber-400/25"
                      : coverTone === "bad"
                        ? "border-[#FF5C6A]/25"
                        : "border-white/[0.06]"
                } bg-[#0E1614]/90`}
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
                  Coverage
                </div>
                <div
                  className={`mt-2 font-mono text-[22px] font-semibold tabular-nums ${
                    coverTone === "good"
                      ? "text-[#14F195]"
                      : coverTone === "warn"
                        ? "text-amber-300"
                        : coverTone === "bad"
                          ? "text-[#FF5C6A]"
                          : ""
                  }`}
                >
                  {cover == null ? "—" : `${(cover * 100).toFixed(0)}%`}
                </div>
                <div className="mt-2 text-[11px] text-[#6b7c74]">On-chain USDC ÷ ledger equity</div>
                <CoverageBar ratio={cover ?? null} />
              </div>
              <StatCard
                label="Pending payouts"
                value={`${data.payouts.pendingCount}`}
                hint={
                  data.payouts.pendingCount
                    ? `${formatAccountUsd(data.payouts.pendingUsd)} waiting`
                    : "Queue clear"
                }
                tone={data.payouts.pendingCount ? "warn" : "good"}
              />
            </div>
          </div>

          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
              Fees & 24h flow
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Fees paid"
                value={formatAccountUsd(data.fees.paid)}
                hint={`${feePct}% / fill · sent ${formatAccountUsd(data.fees.sent)}`}
              />
              <StatCard
                label="Fees pending flush"
                value={formatAccountUsd(data.fees.pending)}
                hint={`→ ${shortAddr(data.feeCollector || FEE_COLLECTOR)}`}
                tone={data.fees.pending >= 0.01 ? "warn" : "default"}
              />
              <StatCard
                label="24h volume"
                value={formatAccountUsd(data.flow24h.volume)}
                hint={`${data.flow24h.fills} fills · fees ${formatAccountUsd(data.flow24h.fees)}`}
              />
              <StatCard
                label="24h net flow"
                value={formatAccountUsd(data.flow24h.deposits - data.flow24h.withdraws)}
                hint={`In ${formatAccountUsd(data.flow24h.deposits)} · out ${formatAccountUsd(data.flow24h.withdraws)}`}
              />
            </div>
          </div>

          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
              Desk activity
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Traders"
                value={String(data.traders.withBalance)}
                hint={`${data.traders.withPositions} in positions · ${data.traders.accounts} accounts`}
              />
              <StatCard
                label="Open positions"
                value={String(data.traders.openPositions)}
                hint={`Principal in ${formatAccountUsd(data.vault.fundedIn)} · out ${formatAccountUsd(data.vault.fundedOut)}`}
              />
              <StatCard
                label="Gift outstanding"
                value={formatAccountUsd(data.traders.giftOutstanding)}
                hint={`${data.traders.giftClaims} claims`}
              />
              <StatCard
                label="Net principal"
                value={formatAccountUsd(data.vault.netPrincipal)}
                hint="Funded deposits still on the desk"
              />
            </div>
          </div>

          {data.payouts.pendingCount > 0 && (
            <Link
              href="/admin/payouts"
              className="flex items-center justify-between gap-3 rounded-[14px] border border-amber-400/25 bg-gradient-to-r from-amber-500/10 to-transparent px-4 py-3.5 text-[13px] text-amber-100 transition-colors hover:border-amber-300/40"
            >
              <span>
                <span className="font-semibold">{data.payouts.pendingCount}</span> payout
                {data.payouts.pendingCount === 1 ? "" : "s"} need approval (
                {formatAccountUsd(data.payouts.pendingUsd)})
              </span>
              <span className="shrink-0 font-semibold text-amber-200">Review →</span>
            </Link>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Open interest by market">
              {data.markets.length === 0 ? (
                <EmptyState title="No open positions" body="OI appears here when traders hold size." />
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7c74]">
                      <th className="px-4 py-2.5">Market</th>
                      <th className="px-4 py-2.5 text-right">Long</th>
                      <th className="px-4 py-2.5 text-right">Short</th>
                      <th className="px-4 py-2.5 text-right">Notional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.markets.map((m) => (
                      <tr key={m.marketId} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold">{m.symbol}</td>
                        <td className="px-4 py-3 text-right font-mono text-[#14F195]">
                          {m.long.toFixed(3)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[#FF5C6A]">
                          {m.short.toFixed(3)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {formatAccountUsd(m.notional)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="Recent deposits / withdrawals">
              {data.recentTransfers.length === 0 ? (
                <EmptyState title="No transfers yet" />
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7c74]">
                      <th className="px-4 py-2.5">When</th>
                      <th className="px-4 py-2.5">Owner</th>
                      <th className="px-4 py-2.5">Kind</th>
                      <th className="px-4 py-2.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentTransfers.slice(0, 5).map((t) => (
                      <tr key={t.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-4 py-3">
                          <WhenCell ts={t.at} />
                        </td>
                        <td className="px-4 py-3">
                          <Addr value={t.owner} />
                        </td>
                        <td
                          className={`px-4 py-3 capitalize ${
                            t.kind === "deposit" ? "text-[#14F195]" : "text-[#FF5C6A]"
                          }`}
                        >
                          {t.kind}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {formatAccountUsd(t.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <Section
            title="Recent fills"
            action={
              <Link href="/admin/traders" className="text-[11px] font-semibold text-[#8A9B94] hover:text-[#14F195]">
                All traders →
              </Link>
            }
          >
            {data.recentFills.length === 0 ? (
              <EmptyState title="No fills yet" body="Trades print here as soon as they fill." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7c74]">
                      <th className="px-4 py-2.5">When</th>
                      <th className="px-4 py-2.5">Owner</th>
                      <th className="px-4 py-2.5">Market</th>
                      <th className="px-4 py-2.5">Side</th>
                      <th className="px-4 py-2.5 text-right">Size</th>
                      <th className="px-4 py-2.5 text-right">Price</th>
                      <th className="px-4 py-2.5 text-right">Fee</th>
                      <th className="px-4 py-2.5 text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentFills.slice(0, 5).map((f) => (
                      <tr key={f.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-4 py-3">
                          <WhenCell ts={f.at} />
                        </td>
                        <td className="px-4 py-3">
                          <Addr value={f.owner} />
                        </td>
                        <td className="px-4 py-3 font-semibold">{symbolFor(f.marketId)}</td>
                        <td
                          className={`px-4 py-3 ${
                            f.isLong ? "text-[#14F195]" : "text-[#FF5C6A]"
                          }`}
                        >
                          {f.isLong ? "Long" : "Short"} · {f.reason}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">{f.size.toFixed(3)}</td>
                        <td className="px-4 py-3 text-right font-mono">
                          {formatAccountUsd(f.price)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[#8A9B94]">
                          {formatAccountUsd(f.fee ?? 0)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono ${
                            f.pnl > 0
                              ? "text-[#14F195]"
                              : f.pnl < 0
                                ? "text-[#FF5C6A]"
                                : "text-[#8A9B94]"
                          }`}
                        >
                          {formatAccountUsd(f.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      )}
    </AdminShell>
  );
}
