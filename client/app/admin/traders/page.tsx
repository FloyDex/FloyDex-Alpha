"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatAccountUsd } from "@/lib/format";
import {
  AdminShell,
  Addr,
  EmptyState,
  FilterChip,
  LiveDot,
  Section,
  StatCard,
  StatusBadge,
  WhenCell,
} from "@/components/admin/AdminShell";

type Trader = {
  owner: string;
  equity: number;
  deposited: number;
  realized: number;
  feesPaid: number;
  fundedIn: number;
  fundedOut: number;
  principalLeft: number;
  usedMargin: number;
  freeCollateral: number;
  positions: number;
  fills: number;
  volume: number;
  giftUsd: number;
  giftLeft: number;
  banned?: boolean;
  ban?: { owner: string; at: number; reason?: string } | null;
  payouts?: {
    pendingCount: number;
    pendingUsd: number;
    approvedCount: number;
    approvedUsd: number;
    rejectedCount: number;
    rejectedUsd: number;
    totalCount: number;
    latest: {
      id: string;
      amount: number;
      status: "pending" | "approved" | "rejected";
      createdAt: number;
      resolvedAt?: number;
    } | null;
  };
  lastFillAt: number;
  lastTransferAt: number;
};

function WithdrawalCell({ t }: { t: Trader }) {
  const p = t.payouts;
  if (!p || p.totalCount === 0) {
    return <span className="text-[#6b7c74]">None</span>;
  }

  if (p.pendingCount > 0) {
    return (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge status="pending" />
        <span className="font-mono text-[11px] text-amber-300">
          {formatAccountUsd(p.pendingUsd)} waiting
          {p.pendingCount > 1 ? ` · ${p.pendingCount}` : ""}
        </span>
      </div>
    );
  }

  const latest = p.latest;
  if (!latest) return <span className="text-[#6b7c74]">—</span>;

  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge status={latest.status} />
      <span className="font-mono text-[11px] text-[#8A9B94]">
        {formatAccountUsd(latest.amount)}
        {p.approvedCount + p.rejectedCount > 1
          ? ` · ${p.approvedCount} ok / ${p.rejectedCount} no`
          : ""}
      </span>
    </div>
  );
}

function pnlClass(n: number) {
  if (n > 0) return "text-[#14F195]";
  if (n < 0) return "text-[#FF5C6A]";
  return "text-[#8A9B94]";
}

function signedUsd(n: number) {
  const body = formatAccountUsd(Math.abs(n));
  if (n > 0) return `+${body}`;
  if (n < 0) return `−${body}`;
  return body;
}

export default function AdminTradersPage() {
  const router = useRouter();
  const [traders, setTraders] = useState<Trader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "banned" | "pending">("all");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [banInput, setBanInput] = useState("");
  const [banReason, setBanReason] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/traders", { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/admin/login?next=/admin/traders");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      traders?: Trader[];
    };
    if (!res.ok || data.ok === false) {
      setError(data.error ?? "Failed to load");
      return;
    }
    setError(null);
    setTraders(data.traders ?? []);
    setReady(true);
  }, [router]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function setBan(owner: string, action: "ban" | "unban", reason?: string) {
    setBusy(owner + action);
    setError(null);
    try {
      const res = await fetch("/api/admin/bans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, action, reason }),
      });
      if (res.status === 401) {
        router.replace("/admin/login?next=/admin/traders");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? "Ban action failed");
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function banFromInput() {
    const owner = banInput.trim();
    if (!owner) return;
    await setBan(owner, "ban", banReason.trim() || undefined);
    setBanInput("");
    setBanReason("");
  }

  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    let list = traders;
    if (filter === "banned") list = list.filter((t) => t.banned);
    if (filter === "pending") list = list.filter((t) => (t.payouts?.pendingCount ?? 0) > 0);
    if (needle) list = list.filter((t) => t.owner.toLowerCase().includes(needle));
    return list;
  }, [traders, needle, filter]);

  const bannedCount = useMemo(() => traders.filter((t) => t.banned).length, [traders]);
  const pendingPayoutCount = useMemo(
    () => traders.filter((t) => (t.payouts?.pendingCount ?? 0) > 0).length,
    [traders],
  );

  const totals = useMemo(() => {
    return {
      deposited: rows.reduce((s, t) => s + t.fundedIn, 0),
      withdrawn: rows.reduce((s, t) => s + t.fundedOut, 0),
      withdrawable: rows.reduce((s, t) => s + Math.max(0, t.freeCollateral), 0),
      pnl: rows.reduce((s, t) => s + t.realized, 0),
    };
  }, [rows]);

  return (
    <AdminShell
      title="Traders"
      subtitle="Deposits, withdrawals, withdrawable balance, P/L — and ban wallets from the desk."
      trailing={<LiveDot />}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Deposited"
          value={formatAccountUsd(totals.deposited)}
          hint={`${rows.length} of ${traders.length} accounts`}
        />
        <StatCard label="Withdrawn" value={formatAccountUsd(totals.withdrawn)} />
        <StatCard label="Withdrawable" value={formatAccountUsd(totals.withdrawable)} hint="Free collateral now" />
        <StatCard
          label="P/L (realized)"
          value={signedUsd(totals.pnl)}
          tone={totals.pnl > 0 ? "good" : totals.pnl < 0 ? "bad" : "default"}
        />
      </div>

      <Section title="Ban a wallet">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-[12px] text-[#8A9B94]">
            Wallet address
            <input
              value={banInput}
              onChange={(e) => setBanInput(e.target.value)}
              placeholder="Paste Solana address…"
              className="mt-1.5 h-10 w-full rounded-[10px] border border-white/[0.08] bg-[#070B0A]/80 px-3 font-mono text-[12px] text-[#f5f5f5] outline-none focus:border-[#FF5C6A]/40"
            />
          </label>
          <label className="min-w-0 flex-1 text-[12px] text-[#8A9B94]">
            Reason (optional)
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="Abuse, chargeback, …"
              className="mt-1.5 h-10 w-full rounded-[10px] border border-white/[0.08] bg-[#070B0A]/80 px-3 text-[13px] text-[#f5f5f5] outline-none focus:border-white/20"
            />
          </label>
          <button
            type="button"
            disabled={!banInput.trim() || busy !== null}
            onClick={() => void banFromInput()}
            className="h-10 shrink-0 rounded-[10px] bg-[#FF5C6A] px-4 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            Ban wallet
          </button>
        </div>
        <p className="border-t border-white/[0.04] px-4 py-2.5 text-[11px] text-[#6b7c74]">
          Banned wallets cannot deposit, withdraw, trade, claim gift, or stake.
        </p>
      </Section>

      <div className="mb-4 mt-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={traders.length}>
            All
          </FilterChip>
          <FilterChip
            active={filter === "pending"}
            onClick={() => setFilter("pending")}
            count={pendingPayoutCount}
          >
            Awaiting decision
          </FilterChip>
          <FilterChip active={filter === "banned"} onClick={() => setFilter("banned")} count={bannedCount}>
            Banned
          </FilterChip>
        </div>
        <label className="relative block min-w-[200px] flex-1 max-w-md">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#6b7c74]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search wallet address…"
            className="h-10 w-full rounded-[10px] border border-white/[0.08] bg-[#070B0A]/80 pl-9 pr-3 text-[13px] text-[#f5f5f5] outline-none transition-colors placeholder:text-[#6b7c74] focus:border-[#14F195]/35"
          />
        </label>
      </div>

      {error && (
        <p className="mb-4 rounded-[12px] border border-[#FF5C6A]/25 bg-[#2a1216]/80 px-4 py-3 text-[13px] text-[#FF5C6A]">
          {error}
        </p>
      )}

      <Section title="Accounts">
        {!ready ? (
          <div className="h-48 animate-pulse bg-[#0A1210]/40" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No traders match"
            body={needle ? "Try a different address fragment." : "Funded accounts will appear here."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7c74]">
                  <th className="px-4 py-2.5">Owner</th>
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5 text-right">Deposited</th>
                  <th className="px-4 py-2.5 text-right">Withdrawn</th>
                  <th className="px-4 py-2.5 text-right">Withdrawable</th>
                  <th className="px-4 py-2.5">Withdrawal request</th>
                  <th className="px-4 py-2.5 text-right">P/L</th>
                  <th className="px-4 py-2.5 text-right">Equity</th>
                  <th className="px-4 py-2.5 text-right">Fees</th>
                  <th className="px-4 py-2.5">Last fill</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={t.owner}
                    className={`border-t border-white/[0.04] hover:bg-white/[0.02] ${
                      t.banned ? "bg-[#FF5C6A]/[0.04]" : ""
                    }`}
                  >
                    <td className="px-4 py-3.5">
                      <Addr value={t.owner} />
                    </td>
                    <td className="px-4 py-3.5">
                      {t.banned ? (
                        <StatusBadge status="banned" />
                      ) : (
                        <StatusBadge status="active" />
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[13px] font-semibold">
                      {formatAccountUsd(t.fundedIn)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#8A9B94]">
                      {formatAccountUsd(t.fundedOut)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#c5d4cc]">
                      {formatAccountUsd(Math.max(0, t.freeCollateral))}
                    </td>
                    <td className="px-4 py-3.5">
                      <WithdrawalCell t={t} />
                    </td>
                    <td className={`px-4 py-3.5 text-right font-mono text-[13px] font-semibold ${pnlClass(t.realized)}`}>
                      {signedUsd(t.realized)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#8A9B94]">
                      {formatAccountUsd(t.equity)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[#8A9B94]">
                      {formatAccountUsd(t.feesPaid)}
                    </td>
                    <td className="px-4 py-3.5">
                      <WhenCell ts={t.lastFillAt} />
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {t.banned ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void setBan(t.owner, "unban")}
                          className="h-8 rounded-[8px] border border-[#14F195]/35 px-3 text-[11px] font-semibold text-[#14F195] disabled:opacity-40"
                        >
                          {busy === t.owner + "unban" ? "…" : "Unban"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            const reason = window.prompt("Ban reason (optional)") ?? undefined;
                            void setBan(t.owner, "ban", reason || undefined);
                          }}
                          className="h-8 rounded-[8px] border border-[#FF5C6A]/35 px-3 text-[11px] font-semibold text-[#FF5C6A] disabled:opacity-40"
                        >
                          {busy === t.owner + "ban" ? "…" : "Ban"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </AdminShell>
  );
}
