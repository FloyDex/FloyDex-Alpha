"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { TopNav } from "@/components/common/TopNav";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { getAccountHealth, getPositions } from "@/lib/solana/account";
import { amountToHuman, formatAccountUsd, shortenAddress } from "@/lib/format";
import { calcUnrealizedPnl } from "@/lib/math";
import { DepositWithdrawDialog } from "@/features/trade/components/DepositWithdrawDialog";
import { PositionsTable } from "@/features/trade/components/PositionsTable";
import { OpenOrdersTable } from "@/features/trade/components/OpenOrdersTable";
import { OrderHistoryTable } from "@/features/trade/components/OrderHistoryTable";
import { TradeHistoryTable } from "@/features/trade/components/TradeHistoryTable";
import { useCollateral } from "@/features/collateral/useCollateral";
import { AssetLogo, UsdcLogo } from "@/components/common/AssetLogos";
import { apiFetch } from "@/lib/api";
import { SETTLEMENT_ASSET } from "@/config";

const TABS = ["Assets", "Positions", "Open Orders", "Trades", "Orders", "Transfers"] as const;
type Tab = (typeof TABS)[number];
type ChartTab = "equity" | "pnl";

const usd = (n: number) => formatAccountUsd(n);

const signedUsd = (n: number) => `${n > 0 ? "+" : ""}${formatAccountUsd(n)}`;

const pnlClass = (n: number) => (n > 0 ? "text-[#14F195]" : n < 0 ? "text-[#FF5C6A]" : "text-[#6b7c74]");

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const stamp = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function PortfolioPage() {
  const { address, connected } = useWalletStore();
  const { setVisible } = useWalletModal();
  const [tab, setTab] = useState<Tab>("Positions");
  const [chartTab, setChartTab] = useState<ChartTab>("equity");
  const markPrices = useMarketStore((s) => s.markPrices);

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const { data: positions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const { data: collateral } = useCollateral(connected ? address : null);

  const { data: portfolio } = useQuery({
    queryKey: ["portfolio-analytics", address],
    queryFn: async () => {
      const res = await apiFetch(`/api/portfolio/${address}`, { cache: "no-store" });
      if (!res.ok) {
        return {
          analytics: null,
          equityCurve: [] as Array<{ equity: number; unrealizedPnl: number; realizedPnlCum: number; at: string }>,
          pnlHistory: [] as Array<{ kind: string; amount: number; size: number; price: number; marketId: number; at: string }>,
          balanceHistory: [] as Array<{ kind: string; asset: string; amount: number; balanceAfter: number | null; at: string }>,
          fundingHistory: [] as Array<{ marketId: number; amount: number; at: string }>,
        };
      }
      return res.json() as Promise<{
        analytics: {
          realizedPnl: number;
          volume: number;
          tradeCount: number;
          winRate: number;
          totalDeposited: number;
          totalWithdrawn: number;
          totalFundingPaid: number;
          totalFeesPaid: number;
          liquidationCount: number;
        } | null;
        equityCurve: Array<{ equity: number; unrealizedPnl: number; realizedPnlCum: number; at: string }>;
        pnlHistory: Array<{ kind: string; amount: number; size: number; price: number; marketId: number; at: string }>;
        balanceHistory: Array<{ kind: string; asset: string; amount: number; balanceAfter: number | null; at: string }>;
        fundingHistory: Array<{ marketId: number; amount: number; at: string }>;
      }>;
    },
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  const equity = health ? amountToHuman(health.equity) : 0;
  const available = health ? amountToHuman(health.freeCollateral) : 0;
  const used = health ? amountToHuman(health.usedMargin) : 0;
  const unrealizedPnl = positions.reduce((acc, p) => {
    const mp = markPrices[p.marketId];
    return mp ? acc + amountToHuman(calcUnrealizedPnl(p.isLong, p.size, p.entryPrice, mp)) : acc;
  }, 0);
  const a = portfolio?.analytics;
  const realizedPnl = a?.realizedPnl ?? 0;
  const pnl = realizedPnl + unrealizedPnl;
  const volume = a?.volume ?? 0;
  const winRate = a?.winRate ?? 0;
  const equityCurve = portfolio?.equityCurve ?? [];
  const pnlEvents = [...(portfolio?.pnlHistory ?? [])].reverse();
  const pnlCurve = pnlEvents.reduce<Array<{ value: number; label: string }>>((acc, ev) => {
    const prev = acc.at(-1)?.value ?? 0;
    acc.push({ value: prev + ev.amount, label: shortDate(ev.at) });
    return acc;
  }, []);
  const equitySeries = equityCurve.map((p) => ({ value: p.equity, label: shortDate(p.at) }));
  const chartSeries = chartTab === "pnl" ? pnlCurve : equitySeries;
  const ratio = equity > 0 ? Math.min(100, (used / equity) * 100) : 0;
  const held = (collateral ?? []).filter((p) => p.raw !== 0n);
  const allocTotal = held.reduce((s, p) => s + Math.max(0, p.marginValue), 0);

  const stats = useMemo(
    () => [
      { label: "Volume", value: usd(volume) },
      { label: "Win rate", value: `${(winRate * 100).toFixed(1)}%` },
      { label: "Fees paid", value: usd(a?.totalFeesPaid ?? 0) },
      { label: "Net funding", value: usd(a?.totalFundingPaid ?? 0), cls: pnlClass(a?.totalFundingPaid ?? 0) },
    ],
    [volume, winRate, a?.totalFeesPaid, a?.totalFundingPaid],
  );

  return (
    <div
      className="min-h-screen bg-[#070B0A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <main className="mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">Portfolio</h1>
          <p className="mt-1 text-[13px] text-[#6b7c74]">Cross-margin perps account, settled in USDC.</p>
        </div>

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#15221E] px-4 py-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-[22px] items-center rounded-[5px] border border-[#1C332C] bg-[#0E1614] px-2 text-[10px] font-semibold uppercase tracking-[.06em] text-[#c5d4cc]">
                Cross
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">
                {SETTLEMENT_ASSET.code}-M
              </span>
              {connected && address ? (
                <span className="ml-1 truncate font-mono text-[11px] text-[#6b7c74]">{shortenAddress(address)}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <DepositWithdrawDialog
                triggerLabel="Withdraw"
                defaultTab="withdraw"
                triggerClassName="h-8 rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 text-[12px] font-semibold text-[#c5d4cc] transition-colors hover:border-[#2A4A40] hover:text-[#f5f5f5]"
              />
              <DepositWithdrawDialog
                triggerLabel="Deposit"
                defaultTab="deposit"
                triggerClassName="h-8 rounded-[8px] bg-[#14F195] px-3 text-[12px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0]"
              />
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(280px,0.92fr)_minmax(0,1.2fr)_168px]">
            <div className="border-b border-[#15221E] p-5 lg:border-b-0 lg:border-r">
              <div className="text-[11px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">Equity</div>
              <div className="mt-1 font-mono text-[32px] font-semibold leading-none tabular sm:text-[36px]">
                {usd(equity)}
              </div>
              <div className={`mt-2 font-mono text-[13px] tabular ${pnlClass(pnl)}`}>
                {signedUsd(pnl)}{" "}
                <span className="text-[#6b7c74]">realized + unrealized</span>
              </div>

              {!connected ? (
                <button
                  type="button"
                  onClick={() => setVisible(true)}
                  className="mt-4 h-9 rounded-[8px] bg-[#14F195] px-4 text-[13px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0]"
                >
                  Connect Wallet
                </button>
              ) : null}

              <div className="mt-5 grid grid-cols-3 gap-3 border-t border-[#15221E] pt-4">
                <HeroStat label="Available" value={usd(available)} />
                <HeroStat label="Used margin" value={usd(used)} />
                <HeroStat label="Unrealized" value={signedUsd(unrealizedPnl)} cls={pnlClass(unrealizedPnl)} />
              </div>

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-[11px] text-[#6b7c74]">
                  <span>Margin ratio</span>
                  <span className={`font-mono tabular ${ratio > 70 ? "text-[#FF5C6A]" : "text-[#c5d4cc]"}`}>
                    {ratio.toFixed(2)}%
                  </span>
                </div>
                <div className="h-[3px] overflow-hidden rounded-full bg-[#12201C]">
                  <div
                    className={`h-full ${ratio > 70 ? "bg-[#FF5C6A]" : "bg-[#14F195]"}`}
                    style={{ width: `${Math.max(connected ? 2 : 0, ratio)}%` }}
                  />
                </div>
              </div>

              <div className="mt-4">
                {held.length === 0 ? (
                  <div className="flex items-center gap-2 text-[13px] text-[#6b7c74]">
                    <UsdcLogo size={16} />
                    {SETTLEMENT_ASSET.code} · no vault balance
                  </div>
                ) : (
                  held.map((p) => (
                    <div key={p.code} className="flex items-center justify-between gap-3 py-1 text-[13px]">
                      <span className="inline-flex items-center gap-1.5 text-[#8A9B94]">
                        <AssetLogo symbol={p.code} size={16} />
                        {p.code}
                      </span>
                      <span className={`font-mono tabular ${p.raw < 0n ? "text-[#FF5C6A]" : "text-[#f5f5f5]"}`}>
                        {usd(p.marginValue)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="border-b border-[#15221E] p-5 lg:border-b-0 lg:border-r">
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-[#15221E]">
                <div className="flex" role="tablist" aria-label="Portfolio chart">
                  {(
                    [
                      ["equity", "Account value"],
                      ["pnl", "PnL"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={chartTab === id}
                      onClick={() => setChartTab(id)}
                      className={`desk-tab h-8 px-3 text-[12px] ${chartTab === id ? "is-on" : ""}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-[#6b7c74]">30D</span>
              </div>
              <MiniLineChart
                data={chartSeries}
                color={
                  chartTab === "pnl" && (chartSeries.at(-1)?.value ?? 0) < 0 ? "#FF5C6A" : "#14F195"
                }
                emptyText={connected ? "No history yet" : "Connect to load history"}
              />
            </div>

            <div className="flex flex-col items-center justify-center gap-3 px-4 py-5">
              <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">Allocation</div>
              <AllocRing
                slices={held.map((p) => ({
                  code: p.code,
                  value: Math.max(0, p.marginValue),
                }))}
                total={allocTotal}
              />
              <div className="w-full text-center text-[11px] text-[#6b7c74]">
                {held.length === 0 ? "No assets" : `${held.length} collateral`}
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-[12px] border border-[#1C332C] bg-[#070B0A] px-4 py-3">
              <div className="text-[11px] uppercase tracking-[.06em] text-[#6b7c74]">{s.label}</div>
              <div className={`mt-1 font-mono text-[16px] font-semibold tabular ${s.cls ?? "text-[#f5f5f5]"}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex items-center justify-between gap-3 border-b border-[#15221E] px-3">
            <div className="flex min-w-0 overflow-x-auto" role="tablist" aria-label="Portfolio tables" style={{ scrollbarWidth: "none" }}>
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`desk-tab h-11 shrink-0 px-3 text-[12px] ${tab === t ? "is-on" : ""}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-[220px]">
            {tab === "Positions" && <PositionsTable marketFilter="all" sideFilter="both" />}
            {tab === "Open Orders" && <OpenOrdersTable marketFilter="all" sideFilter="both" />}
            {tab === "Orders" && <OrderHistoryTable marketFilter="all" sideFilter="both" />}
            {tab === "Trades" && <TradeHistoryTable marketFilter="all" />}
            {tab === "Assets" && <BalancesTab connected={connected} address={address} />}
            {tab === "Transfers" && (
              <TransfersTab
                connected={connected}
                rows={portfolio?.balanceHistory ?? []}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function HeroStat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</div>
      <div className={`mt-1 font-mono text-[13px] tabular ${cls ?? "text-[#f5f5f5]"}`}>{value}</div>
    </div>
  );
}

function AllocRing({ slices, total }: { slices: Array<{ code: string; value: number }>; total: number }) {
  const r = 15.5;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const colors = ["#14F195", "#5497D5", "#9945FF", "#FFC14A"];
  return (
    <svg width="88" height="88" viewBox="0 0 36 36" aria-hidden>
      <circle cx="18" cy="18" r={r} fill="none" stroke="#12201C" strokeWidth="3.5" />
      {total > 0
        ? slices.map((s, i) => {
            const frac = s.value / total;
            const dash = frac * c;
            const el = (
              <circle
                key={s.code}
                cx="18"
                cy="18"
                r={r}
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth="3.5"
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 18 18)"
              />
            );
            offset += dash;
            return el;
          })
        : null}
    </svg>
  );
}

function MiniLineChart({
  data,
  color,
  emptyText,
}: {
  data: Array<{ value: number; label: string }>;
  color: string;
  emptyText: string;
}) {
  const empty = data.length < 2;
  const series = empty ? [{ value: 0, label: "" }, { value: 0, label: "" }] : data;
  const width = 640;
  const height = 200;
  const padX = 8;
  const padY = 16;
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = series.map((p, i) => {
    const x = padX + (i / Math.max(series.length - 1, 1)) * (width - padX * 2);
    const y = padY + ((max - p.value) / range) * (height - padY * 2);
    return { x, y, ...p };
  });
  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;
  const latest = series[series.length - 1];
  const first = series[0];
  const delta = latest.value - first.value;

  return (
    <div className="relative">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[20px] font-semibold tabular text-[#f5f5f5]">{usd(latest.value)}</div>
          {!empty ? (
            <div className={`mt-0.5 font-mono text-[12px] tabular ${pnlClass(delta)}`}>
              {signedUsd(delta)}
            </div>
          ) : null}
        </div>
        {!empty ? (
          <div className="text-right text-[11px] text-[#6b7c74]">
            <div>{first.label}</div>
            <div>{latest.label}</div>
          </div>
        ) : null}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[180px] w-full overflow-visible">
        {[0, 1, 2, 3].map((i) => {
          const y = padY + (i / 3) * (height - padY * 2);
          return <line key={i} x1={padX} x2={width - padX} y1={y} y2={y} stroke="rgba(255,255,255,.06)" />;
        })}
        {!empty ? <polygon points={area} fill={color} opacity="0.1" /> : null}
        <polyline
          points={line}
          fill="none"
          stroke={empty ? "#1C332C" : color}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {!empty
          ? points.slice(-1).map((p) => (
              <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r="3.5" fill={color} stroke="#070B0A" strokeWidth="2" />
            ))
          : null}
      </svg>
      {empty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 pt-8 text-center text-[13px] text-[#6b7c74]">
          {emptyText}
        </div>
      ) : null}
    </div>
  );
}

function BalancesTab({ connected, address }: { connected: boolean; address: string | null }) {
  const { data: positions, isLoading } = useCollateral(address);

  if (!connected) return <Empty text="Connect a wallet to view balances" />;
  if (isLoading || !positions) return <Empty text="Loading balances…" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[13px] tabular">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#6b7c74]">
            <th className="py-2.5 pl-4 pr-2 text-left">Asset</th>
            <th className="px-3 py-2.5 text-right">Wallet</th>
            <th className="px-3 py-2.5 text-right">Vault</th>
            <th className="px-3 py-2.5 text-right">Price</th>
            <th className="px-3 py-2.5 text-right">Haircut</th>
            <th className="py-2.5 pl-2 pr-4 text-right">Margin value</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.code} className="border-t border-[#15221E] hover:bg-[#0E1614]">
              <td className="py-3 pl-4 pr-2 text-left">
                <span className="inline-flex items-center gap-2">
                  <AssetLogo symbol={p.code} size={18} />
                  <span className="font-semibold text-[#f5f5f5]">{p.code}</span>
                  {p.settlement ? (
                    <span className="rounded-[4px] bg-[#12201C] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.04em] text-[#8A9B94]">
                      Settlement
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="px-3 py-3 text-right text-[#8A9B94]">{p.walletBalance.toFixed(2)}</td>
              <td className={`px-3 py-3 text-right ${p.raw < 0n ? "text-[#FF5C6A]" : "text-[#f5f5f5]"}`}>
                {p.balance.toFixed(2)}
              </td>
              <td className="px-3 py-3 text-right text-[#8A9B94]">${p.price.toFixed(4)}</td>
              <td className="px-3 py-3 text-right text-[#8A9B94]">
                {p.haircutBps === 0 ? "—" : `${(p.haircutBps / 100).toFixed(2)}%`}
              </td>
              <td className="py-3 pl-2 pr-4 text-right text-[#f5f5f5]">{usd(p.marginValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransfersTab({
  connected,
  rows,
}: {
  connected: boolean;
  rows: Array<{ kind: string; asset: string; amount: number; balanceAfter: number | null; at: string }>;
}) {
  if (!connected) return <Empty text="Connect a wallet to view transfers" />;
  if (rows.length === 0) return <Empty text="No deposits or withdrawals yet" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px] tabular">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#6b7c74]">
            <th className="py-2.5 pl-4 pr-2 text-left">Time</th>
            <th className="px-3 py-2.5 text-left">Type</th>
            <th className="px-3 py-2.5 text-left">Asset</th>
            <th className="px-3 py-2.5 text-right">Amount</th>
            <th className="py-2.5 pl-2 pr-4 text-right">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const deposit = /deposit|credit/i.test(r.kind);
            const signed = deposit ? Math.abs(r.amount) : -Math.abs(r.amount);
            return (
              <tr key={`${r.at}-${i}`} className="border-t border-[#15221E] hover:bg-[#0E1614]">
                <td className="py-3 pl-4 pr-2 text-left text-[#8A9B94]">{stamp(r.at)}</td>
                <td className="px-3 py-3 text-left capitalize text-[#f5f5f5]">{r.kind.toLowerCase()}</td>
                <td className="px-3 py-3 text-left">
                  <span className="inline-flex items-center gap-1.5">
                    <AssetLogo symbol={r.asset} size={14} />
                    {r.asset}
                  </span>
                </td>
                <td className={`px-3 py-3 text-right font-mono ${signed >= 0 ? "text-[#14F195]" : "text-[#FF5C6A]"}`}>
                  {signed > 0 ? "+" : ""}
                  {signed.toFixed(4)}
                </td>
                <td className="py-3 pl-2 pr-4 text-right text-[#8A9B94]">
                  {r.balanceAfter == null ? "—" : r.balanceAfter.toFixed(4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex items-center justify-center px-4 py-14 text-[13px] text-[#6b7c74]">{text}</div>;
}
