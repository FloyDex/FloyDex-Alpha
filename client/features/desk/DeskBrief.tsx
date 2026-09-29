"use client";

import { useQuery } from "@tanstack/react-query";
import { DEFAULT_MARKET_SYMBOL } from "@/config";

export function DeskBrief({ symbol = DEFAULT_MARKET_SYMBOL }: { symbol?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["desk-brief", symbol],
    queryFn: async () => {
      const res = await fetch("/api/desk/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, session: "Regular" }),
      });
      if (!res.ok) throw new Error("desk brief failed");
      return (await res.json()) as { source: string; route: string | null; text: string };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  return (
    <aside className="rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#14F195]">
          Desk
        </span>
        <span className="text-[10px] text-[#6b7c74]">
          {isLoading ? "routing…" : data?.source === "usepod" ? "UsePod" : "session model"}
        </span>
      </div>
      <p className="text-[12px] leading-relaxed text-[#c5d4cc]">
        {isLoading ? "Asking the inference market for a session brief…" : data?.text}
      </p>
    </aside>
  );
}
