"use client";

import { FormEvent, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FloyDexLogo } from "@/components/common/FloyDexLogo";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/admin";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? "Login failed");
        return;
      }
      router.replace(next.startsWith("/admin") ? next : "/admin");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(700px 360px at 50% 20%, rgba(20,241,149,0.08), transparent 55%), linear-gradient(180deg, #070B0A 0%, #050807 100%)",
        }}
      />
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="relative w-full max-w-sm rounded-[16px] border border-white/[0.08] bg-[#0E1614]/95 p-7 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="mb-6 flex items-center gap-3">
          <FloyDexLogo size={36} className="text-[#14F195]" />
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6b7c74]">
              FloyDex desk
            </div>
            <h1 className="text-[18px] font-bold tracking-tight text-[#f5f5f5]">Operator login</h1>
          </div>
        </div>
        <p className="text-[12px] leading-relaxed text-[#8A9B94]">
          Password-gated console. Not indexed and not linked from the public site.
        </p>
        <label className="mt-6 flex flex-col gap-1.5 text-[12px] font-medium text-[#8A9B94]">
          Password
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 rounded-[10px] border border-white/[0.08] bg-[#070B0A] px-3 text-[14px] text-[#f5f5f5] outline-none transition-colors focus:border-[#14F195]/40"
          />
        </label>
        {error && <p className="mt-3 text-[12px] text-[#FF5C6A]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-6 h-11 w-full rounded-[10px] bg-[#14F195] text-[13px] font-semibold text-[#070B0A] transition-opacity disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center text-[13px] text-[#8A9B94]">
          Loading…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
