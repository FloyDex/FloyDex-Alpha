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
  StatusBadge,
  WhenCell,
} from "@/components/admin/AdminShell";

type Payout = {
  id: string;
  owner: string;
  amount: number;
  overPrincipal: number;
  principalLeft: number;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedAt?: number;
  signature?: string;
  note?: string;
};

export default function AdminPayoutsPage() {
  const router = useRouter();
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const q = filter === "pending" ? "?status=pending" : "";
    const res = await fetch(`/api/admin/payouts${q}`, { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/admin/login?next=/admin/payouts");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      payouts?: Payout[];
    };
    if (!res.ok || data.ok === false) {
      setError(data.error ?? "Failed to load");
      setPayouts([]);
      return;
    }
    setPayouts(data.payouts ?? []);
    setReady(true);
  }, [filter, router]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 12_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(id: string, action: "approve" | "reject") {
    setBusy(id + action);
    setError(null);
    try {
      const res = await fetch("/api/admin/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.status === 401) {
        router.replace("/admin/login?next=/admin/payouts");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? "Action failed");
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  const pendingUsd = useMemo(
    () => payouts.filter((p) => p.status === "pending").reduce((s, p) => s + p.amount, 0),
    [payouts],
  );

  return (
    <AdminShell
      title="Payouts"
      subtitle="Withdrawals above funded deposits wait here. Approve sends USDC from treasury; rejecting unlocks the trader's balance."
      trailing={<LiveDot />}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterChip active={filter === "pending"} onClick={() => setFilter("pending")} count={filter === "pending" ? payouts.length : undefined}>
            Pending
          </FilterChip>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All history
          </FilterChip>
        </div>
        {ready && filter === "pending" && (
          <p className="text-[12px] text-[#8A9B94]">
            <span className="font-mono font-semibold text-[#f5f5f5]">{formatAccountUsd(pendingUsd)}</span>
            {" "}queued
          </p>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-[12px] border border-[#FF5C6A]/25 bg-[#2a1216]/80 px-4 py-3 text-[13px] text-[#FF5C6A]">
          {error}
        </p>
      )}

      <Section title={filter === "pending" ? "Approval queue" : "Payout history"}>
        {!ready ? (
          <div className="h-40 animate-pulse bg-[#0A1210]/40" />
        ) : payouts.length === 0 ? (
          <EmptyState
            title={filter === "pending" ? "Queue is clear" : "No payouts yet"}
            body={
              filter === "pending"
                ? "Over-principal withdrawals will land here for review."
                : "Approved and rejected payouts show up in All history."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7c74]">
                  <th className="px-4 py-2.5">When</th>
                  <th className="px-4 py-2.5">Owner</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Over principal</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="px-4 py-3.5">
                      <WhenCell ts={p.createdAt} />
                    </td>
                    <td className="px-4 py-3.5">
                      <Addr value={p.owner} />
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[13px] font-semibold">
                      {formatAccountUsd(p.amount)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-amber-300">
                      {formatAccountUsd(p.overPrincipal)}
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {p.status === "pending" ? (
                        <span className="inline-flex gap-2">
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void act(p.id, "approve")}
                            className="h-8 rounded-[8px] bg-[#14F195] px-3 text-[11px] font-semibold text-[#070B0A] transition-opacity disabled:opacity-40"
                          >
                            {busy === p.id + "approve" ? "Sending…" : "Approve"}
                          </button>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void act(p.id, "reject")}
                            className="h-8 rounded-[8px] border border-[#FF5C6A]/35 px-3 text-[11px] font-semibold text-[#FF5C6A] transition-colors hover:bg-[#FF5C6A]/10 disabled:opacity-40"
                          >
                            Reject
                          </button>
                        </span>
                      ) : p.signature ? (
                        <span className="font-mono text-[10px] text-[#6b7c74]" title={p.signature}>
                          {p.signature.slice(0, 10)}…
                        </span>
                      ) : (
                        <span className="text-[#6b7c74]">—</span>
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
