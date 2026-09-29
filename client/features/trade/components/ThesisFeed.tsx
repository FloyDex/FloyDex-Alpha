"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import type { MarketConfig } from "@/config";
import { logoFor } from "@/components/common/AssetLogos";
import { apiFetch } from "@/lib/api";
import { CALLOUT_MAX_CHARS, type Callout, type CalloutSide } from "@/lib/market/callouts";
import { shortenAddress } from "@/lib/format";
import { useWalletStore } from "@/stores/wallet";

const SIDES: { id: CalloutSide; label: string }[] = [
  { id: "long", label: "Long" },
  { id: "short", label: "Short" },
  { id: "neutral", label: "Note" },
];

function sideLabel(side: CalloutSide): string {
  if (side === "long") return "Long";
  if (side === "short") return "Short";
  return "Note";
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function accentClass(side: CalloutSide): string {
  if (side === "long") return "bg-[#14F195]";
  if (side === "short") return "bg-[#FF5C6A]";
  return "bg-[#3d524c]";
}

function chipClass(side: CalloutSide): string {
  if (side === "long") return "bg-[#14F195]/12 text-[#14F195]";
  if (side === "short") return "bg-[#FF5C6A]/12 text-[#FF5C6A]";
  return "bg-[#15221E] text-[#8A9B94]";
}

function SideChip({
  id,
  label,
  on,
  onPick,
}: {
  id: CalloutSide;
  label: string;
  on: boolean;
  onPick: (id: CalloutSide) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onPick(id)}
      className={`h-7 rounded-[6px] border px-2.5 text-[11px] font-semibold ${
        on
          ? id === "long"
            ? "border-[#14F195]/35 bg-[#14F195]/15 text-[#14F195]"
            : id === "short"
              ? "border-[#FF5C6A]/35 bg-[#FF5C6A]/15 text-[#FF5C6A]"
              : "border-[#2A4A40] bg-[#15221E] text-[#f5f5f5]"
          : "border-[#1C332C] bg-transparent text-[#8A9B94] hover:text-[#d5ddd8]"
      }`}
    >
      {label}
    </button>
  );
}

function MixBar({ posts }: { posts: Callout[] }) {
  const long = posts.filter((p) => p.side === "long").length;
  const short = posts.filter((p) => p.side === "short").length;
  const note = posts.filter((p) => p.side === "neutral").length;
  const n = posts.length;
  if (n === 0) return null;
  return (
    <div className="mt-2">
      <div className="flex h-[3px] overflow-hidden rounded-full bg-[#12201C]">
        {long > 0 ? <div className="h-full bg-[#14F195]" style={{ width: `${(long / n) * 100}%` }} /> : null}
        {short > 0 ? <div className="h-full bg-[#FF5C6A]" style={{ width: `${(short / n) * 100}%` }} /> : null}
        {note > 0 ? <div className="h-full bg-[#3d524c]" style={{ width: `${(note / n) * 100}%` }} /> : null}
      </div>
      <div className="mt-1.5 flex gap-3 text-[10px] font-medium uppercase tracking-[.05em] text-[#6b7c74]">
        <span className="text-[#14F195]">{long} long</span>
        <span className="text-[#FF5C6A]">{short} short</span>
        <span>{note} note</span>
      </div>
    </div>
  );
}

export function ThesisFeed({ market }: { market: MarketConfig }) {
  const { address, connected } = useWalletStore();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<CalloutSide>("long");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<"new" | "top">("new");
  const [composing, setComposing] = useState(false);

  const { data, isPending, isError } = useQuery({
    queryKey: ["callouts", market.marketId, sort],
    queryFn: async () => {
      const res = await apiFetch(`/api/callouts?marketId=${market.marketId}&sort=${sort}`, { cache: "no-store" });
      if (!res.ok) throw new Error("callouts unavailable");
      return (await res.json()) as { posts: Callout[] };
    },
    refetchInterval: 15_000,
  });
  const posts = data?.posts ?? [];
  const mixPosts = useMemo(() => data?.posts ?? [], [data?.posts]);

  const postMut = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/callouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: address, marketId: market.marketId, side, text }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) throw new Error(json.error ?? "Could not post");
    },
    onSuccess: () => {
      setText("");
      setComposing(false);
      queryClient.invalidateQueries({ queryKey: ["callouts", market.marketId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const likeMut = useMutation({
    mutationFn: async (likeId: string) => {
      const res = await apiFetch("/api/callouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: address, likeId }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) throw new Error(json.error ?? "Could not like");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["callouts", market.marketId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const trimmed = text.trim().length;
  const canPost = connected && trimmed >= 8 && !postMut.isPending;
  const nearLimit = trimmed >= CALLOUT_MAX_CHARS - 40;
  const openComposer = composing || trimmed > 0;
  const why =
    side === "neutral" ? `Note on ${market.baseAsset}` : `Why ${side} ${market.baseAsset}?`;
  const empty = !isPending && !isError && posts.length === 0;

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canPost) {
      e.preventDefault();
      postMut.mutate();
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#070B0A]">
      <header className="shrink-0 border-b border-[#15221E] px-4 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {logoFor(market.baseAsset, 22)}
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[#f5f5f5]">
                {market.baseAsset} calls
              </div>
              <div className="truncate text-[11px] text-[#6b7c74]">
                {empty ? "No calls yet — not advice." : "Long, short, or a note from the tape. Not advice."}
              </div>
            </div>
          </div>
          <div className="desk-seg shrink-0" role="tablist" aria-label="Sort calls">
            {(["new", "top"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sort === id}
                onClick={() => setSort(id)}
                className={`px-2.5 capitalize ${sort === id ? "is-on" : ""}`}
              >
                {id}
              </button>
            ))}
          </div>
        </div>
        <MixBar posts={mixPosts} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[88px] animate-pulse rounded-[10px] bg-[#0E1614]" />
            ))}
          </div>
        ) : isError ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <p className="text-[12px] text-[#8A9B94]">Calls are unavailable right now.</p>
          </div>
        ) : empty ? (
          <div className="flex h-full min-h-[72px] flex-col items-center justify-center px-4 text-center">
            <div className="text-[13px] font-medium text-[#c5d4cc]">Be the first call on {market.baseAsset}</div>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-[#6b7c74]">
              Post a long, short, or note from the dock below.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {posts.map((p) => {
              const liked = Boolean(address && p.likes.includes(address));
              const liking = likeMut.isPending && likeMut.variables === p.id;
              return (
                <article
                  key={p.id}
                  className="relative overflow-hidden rounded-[10px] border border-[#1C332C] bg-[#0B1210] px-3 py-2.5 pl-4"
                >
                  <span className={`absolute inset-y-2 left-[6px] w-[2px] rounded-full ${accentClass(p.side)}`} />
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#12201C] font-mono text-[10px] font-semibold text-[#14F195]">
                        {p.owner.slice(0, 2)}
                      </span>
                      <span className="truncate font-mono text-[12px] text-[#c5d4cc]">
                        {shortenAddress(p.owner)}
                      </span>
                      <span
                        className={`rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.04em] ${chipClass(p.side)}`}
                      >
                        {sideLabel(p.side)}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11px] tabular text-[#6b7c74]">{timeAgo(p.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#e8eee9]">{p.text}</p>
                  <button
                    type="button"
                    disabled={!connected || liking}
                    aria-label={liked ? "Unlike call" : "Like call"}
                    aria-pressed={liked}
                    onClick={() => likeMut.mutate(p.id)}
                    className={`mt-2 inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium ${
                      liked
                        ? "bg-[#14F195]/10 text-[#14F195]"
                        : "text-[#6b7c74] hover:bg-white/[.04] hover:text-[#c5d4cc]"
                    } disabled:opacity-40`}
                  >
                    <Heart size={12} fill={liked ? "currentColor" : "none"} />
                    {p.likes.length}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-[#15221E] bg-[#0A100E] px-3 py-2">
        {openComposer ? (
          <div className="mb-1.5 flex gap-1">
            {SIDES.map(({ id, label }) => (
              <SideChip key={id} id={id} label={label} on={side === id} onPick={setSide} />
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          {openComposer ? null : (
            <div className="flex shrink-0 gap-1">
              {SIDES.map(({ id, label }) => (
                <SideChip key={id} id={id} label={label} on={side === id} onPick={setSide} />
              ))}
            </div>
          )}
          <textarea
            value={text}
            maxLength={CALLOUT_MAX_CHARS}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onComposerKey}
            onFocus={() => setComposing(true)}
            onBlur={() => {
              if (!text.trim()) setComposing(false);
            }}
            aria-label={why}
            placeholder={why}
            rows={openComposer ? 3 : 1}
            className={`min-w-0 flex-1 resize-none rounded-[8px] border border-[#1C332C] bg-[#070B0A] px-3 text-[13px] leading-relaxed text-[#f5f5f5] outline-none placeholder:text-[#5c6b64] focus:border-[#14F195]/35 ${
              openComposer ? "h-[72px] py-2" : "h-9 py-1.5"
            }`}
          />
          <button
            type="button"
            disabled={!canPost}
            onClick={() => postMut.mutate()}
            className="desk-btn-long h-8 shrink-0 rounded-[7px] px-3.5 text-[12px] font-semibold disabled:opacity-35"
          >
            {postMut.isPending ? "Posting" : "Post"}
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-[#6b7c74]">
          <span>
            {connected
              ? trimmed > 0 && trimmed < 8
                ? "At least 8 characters"
                : "⌘/Ctrl + Enter to post"
              : "Connect a wallet in the header to post"}
          </span>
          <span className={`tabular ${nearLimit ? "text-[#e8c36a]" : ""}`}>
            {trimmed}/{CALLOUT_MAX_CHARS}
          </span>
        </div>
      </footer>
    </div>
  );
}
