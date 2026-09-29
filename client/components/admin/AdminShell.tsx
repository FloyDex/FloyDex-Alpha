"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { FloyDexLogo } from "@/components/common/FloyDexLogo";

const NAV: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/payouts", label: "Payouts" },
  { href: "/admin/traders", label: "Traders" },
];

export function AdminShell({
  title,
  subtitle,
  children,
  trailing,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <div className="admin-desk relative min-h-screen text-[#f5f5f5]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{
          background:
            "radial-gradient(900px 420px at 12% -8%, rgba(20,241,149,0.07), transparent 55%), radial-gradient(700px 380px at 92% 0%, rgba(20,241,149,0.04), transparent 50%), linear-gradient(180deg, #070B0A 0%, #050807 100%)",
        }}
      />

      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#070B0A]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/admin" className="shrink-0" aria-label="Desk home">
              <FloyDexLogo size={28} className="text-[#14F195]" />
            </Link>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b7c74]">
                FloyDex desk
              </div>
              <div className="truncate text-[13px] font-semibold text-[#c5d4cc]">Operator console</div>
            </div>
          </div>

          <nav className="hidden items-center gap-1 rounded-[10px] border border-white/[0.06] bg-[#0A1210]/80 p-1 sm:flex">
            {NAV.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-[7px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    active
                      ? "bg-[#15221E] text-[#14F195]"
                      : "text-[#6b7c74] hover:text-[#c5d4cc]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={() => void logout()}
            className="h-8 shrink-0 rounded-[8px] border border-white/[0.08] px-3 text-[12px] font-semibold text-[#8A9B94] transition-colors hover:border-white/20 hover:text-[#f5f5f5]"
          >
            Log out
          </button>
        </div>

        <div className="mx-auto flex gap-1 overflow-x-auto px-4 pb-3 sm:hidden">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                  active
                    ? "bg-[#15221E] text-[#14F195]"
                    : "border border-white/[0.06] text-[#6b7c74]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-4 pb-16 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-tight sm:text-[28px]">{title}</h1>
            {subtitle && (
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[#8A9B94]">{subtitle}</p>
            )}
          </div>
          {trailing ? <div className="flex flex-wrap items-center gap-2">{trailing}</div> : null}
        </div>
        <div className="mt-7">{children}</div>
      </main>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const valueClass =
    tone === "good"
      ? "text-[#14F195]"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-[#FF5C6A]"
          : "text-[#f5f5f5]";
  const ring =
    tone === "good"
      ? "border-[#14F195]/20"
      : tone === "warn"
        ? "border-amber-400/25"
        : tone === "bad"
          ? "border-[#FF5C6A]/25"
          : "border-white/[0.06]";

  return (
    <div
      className={`rounded-[14px] border ${ring} bg-[#0E1614]/90 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
        {label}
      </div>
      <div className={`mt-2 font-mono text-[22px] font-semibold leading-none tabular-nums ${valueClass}`}>
        {value}
      </div>
      {hint && <div className="mt-2 text-[11px] leading-snug text-[#6b7c74]">{hint}</div>}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[14px] border border-white/[0.06] bg-[#0E1614]/70">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7c74]">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-3 h-10 w-10 rounded-full border border-dashed border-white/10" />
      <p className="text-[13px] font-medium text-[#c5d4cc]">{title}</p>
      {body && <p className="mt-1 max-w-xs text-[12px] text-[#6b7c74]">{body}</p>}
    </div>
  );
}

export function StatusBadge({
  status,
}: {
  status: "pending" | "approved" | "rejected" | "banned" | "active" | string;
}) {
  const map: Record<string, string> = {
    pending: "bg-amber-400/10 text-amber-300 border-amber-400/20",
    approved: "bg-[#14F195]/10 text-[#14F195] border-[#14F195]/20",
    rejected: "bg-[#FF5C6A]/10 text-[#FF5C6A] border-[#FF5C6A]/20",
    banned: "bg-[#FF5C6A]/10 text-[#FF5C6A] border-[#FF5C6A]/20",
    active: "bg-white/[0.04] text-[#8A9B94] border-white/[0.08]",
  };
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        map[status] ?? "border-white/10 text-[#8A9B94]"
      }`}
    >
      {status}
    </span>
  );
}

export function FilterChip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold transition-colors ${
        active
          ? "bg-[#14F195] text-[#070B0A]"
          : "border border-white/[0.08] text-[#8A9B94] hover:border-white/20 hover:text-[#f5f5f5]"
      }`}
    >
      {children}
      {count != null && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
            active ? "bg-[#070B0A]/15" : "bg-white/[0.06]"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function LiveDot({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#0A1210] px-2.5 py-1 text-[11px] text-[#8A9B94]">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#14F195] opacity-40" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#14F195]" />
      </span>
      {label ?? "Live"}
    </span>
  );
}

export function shortAddr(a: string) {
  if (a.length < 10) return a;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function Addr({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }
  return (
    <button
      type="button"
      title={value}
      onClick={() => void copy()}
      className="font-mono text-[11px] text-[#c5d4cc] underline-offset-2 hover:text-[#14F195] hover:underline"
    >
      {copied ? "Copied" : shortAddr(value)}
    </button>
  );
}

export function when(ts: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function relativeWhen(ts: number) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function WhenCell({ ts }: { ts: number }) {
  if (!ts) return <span className="text-[#6b7c74]">—</span>;
  return (
    <time dateTime={new Date(ts).toISOString()} title={when(ts)} className="text-[#a3a3a3]">
      {relativeWhen(ts)}
    </time>
  );
}

export function CoverageBar({ ratio }: { ratio: number | null }) {
  if (ratio == null) return null;
  const pct = Math.max(0, Math.min(150, ratio * 100));
  const tone = ratio >= 1 ? "#14F195" : ratio >= 0.8 ? "#FBBF24" : "#FF5C6A";
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, pct)}%`, background: tone }}
      />
    </div>
  );
}

export function SkeletonCards({ n = 4 }: { n?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div
          key={i}
          className="h-[96px] animate-pulse rounded-[14px] border border-white/[0.04] bg-[#0E1614]/60"
        />
      ))}
    </div>
  );
}
