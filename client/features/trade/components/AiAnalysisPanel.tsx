"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import type { MarketConfig } from "@/config";
import { apiFetch } from "@/lib/api";
import {
  clampAiHeightPct,
  clampAiWidth,
  stripDeskEmoji,
  type AiAnalysis,
  type AiChatMessage,
} from "@/lib/market/ai-analysis";
import { useTradeSettings } from "@/stores/settings";
import { AiSpark } from "@/features/trade/components/AiSpark";

const voteKey = (id: number) => `floydex-ai-vote:${id}`;

function deskText(value: string): string {
  return stripDeskEmoji(value.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`+/g, ""));
}

function TechnicalsGauge({ score, label }: { score: number; label: string }) {
  const clamped = Math.max(-1, Math.min(1, score));
  const angle = -90 + ((clamped + 1) / 2) * 180;
  return (
    <div className="flex flex-col items-center px-2">
      <svg viewBox="0 0 220 128" className="h-[108px] w-[196px]">
        <path d="M24 112 A86 86 0 0 1 196 112" fill="none" stroke="#2a2a31" strokeWidth="16" strokeLinecap="round" />
        <path d="M24 112 A86 86 0 0 1 68 38" fill="none" stroke="#e34c4c" strokeWidth="16" strokeLinecap="round" />
        <path d="M152 38 A86 86 0 0 1 196 112" fill="none" stroke="#3b82f6" strokeWidth="16" strokeLinecap="round" />
        <g transform={`rotate(${angle} 110 112)`}>
          <line x1="110" y1="112" x2="110" y2="38" stroke="#f5f5f5" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="110" cy="112" r="5" fill="#f5f5f5" />
        </g>
      </svg>
      <div className="mt-1 text-[18px] font-semibold text-[#f5f5f5]">{label}</div>
    </div>
  );
}

function FearGauge({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const angle = -90 + (clamped / 100) * 180;
  return (
    <div className="flex flex-col items-center px-2">
      <svg viewBox="0 0 220 128" className="h-[108px] w-[196px]">
        <defs>
          <linearGradient id="floy-fng" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#e34c4c" />
            <stop offset="28%" stopColor="#f08a3a" />
            <stop offset="52%" stopColor="#f0b90b" />
            <stop offset="78%" stopColor="#9ad12a" />
            <stop offset="100%" stopColor="#1fae5b" />
          </linearGradient>
        </defs>
        <path
          d="M24 112 A86 86 0 0 1 196 112"
          fill="none"
          stroke="url(#floy-fng)"
          strokeWidth="16"
          strokeLinecap="round"
        />
        <g transform={`rotate(${angle} 110 112)`}>
          <line x1="110" y1="112" x2="110" y2="38" stroke="#f5f5f5" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="110" cy="112" r="5" fill="#f5f5f5" />
        </g>
      </svg>
      <div className="-mt-1 text-[28px] font-bold tabular leading-none text-[#f5f5f5]">
        {Math.round(clamped)}
      </div>
      <div className="mt-1.5 text-[14px] font-semibold text-[#d6c56a]">{label}</div>
    </div>
  );
}

export function AiAnalysisPanel({
  market,
  onClose,
}: {
  market: MarketConfig;
  onClose: () => void;
}) {
  const storedWidth = useTradeSettings((s) => s.aiPanelWidth);
  const storedHeight = useTradeSettings((s) => s.aiPanelHeightPct);
  const setAiPanelSize = useTradeSettings((s) => s.setAiPanelSize);
  const [size, setSize] = useState({
    width: clampAiWidth(storedWidth || 380),
    heightPct: clampAiHeightPct(storedHeight || 100),
  });

  useEffect(() => {
    setSize({
      width: clampAiWidth(storedWidth || 380),
      heightPct: clampAiHeightPct(storedHeight || 100),
    });
  }, [storedWidth, storedHeight]);

  const { data, isLoading } = useQuery({
    queryKey: ["ai-analysis", market.marketId, "xt6"],
    queryFn: async () => {
      const res = await apiFetch(`/api/markets/${market.marketId}/ai`, { cache: "no-store" });
      if (!res.ok) throw new Error("ai unavailable");
      return (await res.json()) as AiAnalysis;
    },
    staleTime: 60_000,
    refetchInterval: 3 * 60_000,
  });

  const [vote, setVote] = useState<"up" | "down" | null>(() => {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem(voteKey(market.marketId));
    return v === "up" || v === "down" ? v : null;
  });
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setDraft("");
  }, [market.marketId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, asking]);

  function onVote(next: "up" | "down") {
    const value = vote === next ? null : next;
    setVote(value);
    if (typeof window !== "undefined") {
      const key = voteKey(market.marketId);
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    }
  }

  function commitSize(next: { width: number; heightPct: number }) {
    setSize(next);
    setAiPanelSize(next.width, next.heightPct);
  }

  function onHeightPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const panel = handle.closest("[data-ai-panel]") as HTMLElement | null;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const parentH = parent.getBoundingClientRect().height || 1;
    let latest = { width: size.width, heightPct: size.heightPct };
    const onMove = (ev: PointerEvent) => {
      const next = {
        width: latest.width,
        heightPct: clampAiHeightPct(((startH + (startY - ev.clientY)) / parentH) * 100),
      };
      latest = next;
      setSize(next);
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setAiPanelSize(latest.width, latest.heightPct);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function onWidthPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const panel = handle.closest("[data-ai-panel]") as HTMLElement | null;
    if (!panel) return;
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let latest = { width: size.width, heightPct: size.heightPct };
    const onMove = (ev: PointerEvent) => {
      const next = {
        width: clampAiWidth(startW + (startX - ev.clientX)),
        heightPct: latest.heightPct,
      };
      latest = next;
      setSize(next);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setAiPanelSize(latest.width, latest.heightPct);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  async function sendQuestion(text?: string) {
    const question = (text ?? draft).replace(/\s+/g, " ").trim();
    if (question.length < 2 || asking) return;
    setDraft("");
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setAsking(true);
    try {
      const res = await apiFetch(`/api/markets/${market.marketId}/ai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const json = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || !json.reply) throw new Error(json.error ?? "ai_unavailable");
      setMessages((m) => [...m, { role: "assistant", content: json.reply! }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "The desk AI is busy. Try that question again in a moment." },
      ]);
    } finally {
      setAsking(false);
    }
  }

  const when = data?.generatedAt
    ? new Date(data.generatedAt).toISOString().slice(0, 19).replace("T", " ")
    : "";

  return (
    <aside
      data-ai-panel
      className="absolute bottom-0 right-0 z-50 flex w-full flex-col border-l border-[#15221E] bg-[#0B1210] text-[#f5f5f5] shadow-[-18px_0_40px_rgba(0,0,0,.55)] max-lg:!w-full"
      style={{ height: `${size.heightPct}%`, width: size.width }}
    >
      <button
        type="button"
        aria-label="Resize AI panel height"
        onPointerDown={onHeightPointerDown}
        onDoubleClick={() =>
          commitSize({
            width: size.width,
            heightPct: size.heightPct >= 96 ? 72 : 100,
          })
        }
        className="flex h-2.5 shrink-0 cursor-ns-resize items-center justify-center"
      >
        <span className="h-0.5 w-8 rounded-full bg-[#2A4A40]" />
      </button>
      <button
        type="button"
        aria-label="Resize AI panel width"
        onPointerDown={onWidthPointerDown}
        className="absolute inset-y-0 left-0 z-10 hidden w-1 cursor-ew-resize hover:bg-[#14F195]/40 lg:block"
      />

      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-0.5">
        <div className="flex items-center gap-2">
          <AiSpark active size={20} busy={isLoading && !data} />
          <div className="text-[15px] font-semibold tracking-[-0.01em]">
            {market.baseAsset} AI Analysis
          </div>
        </div>
        <button
          type="button"
          aria-label="Close AI analysis"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-[6px] text-[#8d8d8d] hover:bg-[#1c1c1c] hover:text-[#f5f5f5]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="shrink-0 px-4 pb-3">
        <div className="text-[13px] font-medium text-[#f5f5f5]">
          {data?.meter.kind === "technicals" ? "Technicals" : "Greed & Fear Index"}
        </div>
        <div className="mt-2">
          {isLoading && !data ? (
            <div className="grid h-[132px] place-items-center">
              <AiSpark busy size={36} />
            </div>
          ) : data?.meter.kind === "technicals" ? (
            <TechnicalsGauge
              score={((data.meter.value / 100) * 2) - 1}
              label={data.meter.label}
            />
          ) : (
            <FearGauge value={data?.meter.value ?? 50} label={data?.meter.label ?? "Neutral"} />
          )}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        <Section title="Bullish" tone="up" items={data?.bullish ?? []} empty="No bullish tape yet." />
        <Section title="Bearish" tone="down" items={data?.bearish ?? []} empty="No bearish tape yet." />

        {messages.map((msg, i) => (
          <div
            key={`${msg.role}-${i}`}
            className={`mt-3 flex gap-2 ${msg.role === "user" ? "justify-end" : "items-start"}`}
          >
            {msg.role === "assistant" && (
              <span className="mt-0.5 shrink-0">
                <AiSpark size={16} active />
              </span>
            )}
            <div
              className={
                msg.role === "user"
                  ? "max-w-[86%] rounded-[12px] bg-[#1f1f1f] px-3 py-2 text-[12.5px] leading-relaxed text-[#f5f5f5]"
                  : "max-w-[90%] text-[12.5px] leading-relaxed text-[#cfcfcf]"
              }
            >
              {deskText(msg.content)}
            </div>
          </div>
        ))}
        {asking && (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-[#8d8d8d]">
            <AiSpark busy size={14} />
            Thinking…
          </div>
        )}
      </div>

      <form
        className="shrink-0 px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void sendQuestion();
        }}
      >
        <div className="flex items-center gap-2 rounded-full border border-[#2e2e2e] bg-[#181818] px-3 py-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 500))}
            aria-label={`Ask about ${market.baseAsset}`}
            placeholder={`Ask about ${market.baseAsset}`}
            className="h-8 w-full bg-transparent text-[12.5px] text-[#f5f5f5] outline-none placeholder:text-[#6f6f6f]"
          />
          <button
            type="submit"
            aria-label="Send question"
            disabled={asking || draft.trim().length < 2}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[#9B6CFF] disabled:text-[#4a4a4a]"
          >
            <Send size={14} />
          </button>
        </div>
      </form>

      <div className="shrink-0 px-4 pb-3">
        {when && <div className="text-[11px] text-[#7a7a7a]">Analysis Time {when}</div>}
        <div className="mt-2 flex items-center gap-2 text-[#8d8d8d]">
          <button
            type="button"
            aria-label="Helpful"
            onClick={() => onVote("up")}
            className={`grid h-7 w-7 place-items-center rounded-[6px] ${vote === "up" ? "text-[#1fae5b]" : "hover:text-[#f5f5f5]"}`}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            type="button"
            aria-label="Not helpful"
            onClick={() => onVote("down")}
            className={`grid h-7 w-7 place-items-center rounded-[6px] ${vote === "down" ? "text-[#e34c4c]" : "hover:text-[#f5f5f5]"}`}
          >
            <ThumbsDown size={14} />
          </button>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-[#6a6a6a]">
          Disclaimer: The content is generated by an AI assistant using third-party data and is
          provided as-is. FloyDex does not guarantee its reliability or accuracy. It is not
          investment advice. Digital asset prices may be highly volatile.
        </p>
      </div>
    </aside>
  );
}

function Section({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: { text: string; posts: number }[];
  empty: string;
  tone: "up" | "down";
}) {
  const rail = tone === "up" ? "border-[#1fae5b]" : "border-[#e34c4c]";
  return (
    <div className="mt-5 first:mt-0">
      <div className="text-[13px] font-semibold tracking-[-0.01em] text-[#f5f5f5]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-2 text-[12px] text-[#737373]">{empty}</p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2.5">
          {items.map((item) => (
            <li
              key={item.text}
              className={`border-l ${rail} pl-3 text-[12.5px] leading-[1.5] text-[#c9c9c9]`}
            >
              {deskText(item.text)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
