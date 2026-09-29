"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { DESK_TOUR_STEPS, type DeskTourRegion } from "@/lib/market/desk-tour";
import { useTradeSettings } from "@/stores/settings";

export function DeskTour({
  onRegion,
}: {
  onRegion?: (region: DeskTourRegion) => void;
}) {
  const deskTourDone = useTradeSettings((s) => s.deskTourDone);
  const deskTourKick = useTradeSettings((s) => s.deskTourKick);
  const setDeskTourDone = useTradeSettings((s) => s.setDeskTourDone);
  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState(0);
  const [forced, setForced] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);
  const lastKick = useRef(0);

  useEffect(() => {
    const finish = () => setHydrated(true);
    const unsub = useTradeSettings.persist.onFinishHydration(finish);
    if (useTradeSettings.persist.hasHydrated()) finish();
    return unsub;
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tour") === "1") setForced(true);
  }, []);

  useEffect(() => {
    if (deskTourKick > 0 && deskTourKick !== lastKick.current) {
      lastKick.current = deskTourKick;
      setForced(true);
      setStep(0);
    }
  }, [deskTourKick]);

  const open = hydrated && (forced || !deskTourDone);
  const current = DESK_TOUR_STEPS[step] ?? DESK_TOUR_STEPS[0];
  const last = step >= DESK_TOUR_STEPS.length - 1;

  useEffect(() => {
    if (!open) return;
    setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    onRegion?.(current.id);
  }, [open, current.id, onRegion]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nextRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, step]);

  function close() {
    setForced(false);
    setDeskTourDone(true);
    setStep(0);
  }

  function next() {
    if (last) close();
    else setStep((s) => s + 1);
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close/next/back close over `last` + `step`.
  }, [open, step, last]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:px-4">
      <button
        type="button"
        aria-label="Dismiss guide"
        className="absolute inset-0 bg-black/70"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-tour-title"
        className="relative z-[81] max-h-[min(92dvh,720px)] w-full max-w-[540px] overflow-y-auto rounded-t-[16px] border border-[#1A2A26] bg-[#0C1412] shadow-[0_24px_80px_rgba(0,0,0,.75)] sm:rounded-[16px]"
        style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
      >
        <div className="flex justify-end px-2 pt-1.5">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="grid h-8 w-8 place-items-center rounded-full text-[#8A9B94] hover:bg-[#15221E] hover:text-[#f5f5f5]"
          >
            <X size={16} />
          </button>
        </div>
        <DeskPreview region={current.id} />
        <div className="px-6 pb-5 pt-4">
          <h2 id="desk-tour-title" className="text-[18px] font-semibold text-[#f5f5f5]">
            {current.title}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[#8A9B94]">{current.body}</p>
          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1" aria-hidden>
              {DESK_TOUR_STEPS.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-[3px] rounded-full transition-all ${
                    i === step ? "w-6 bg-[#14F195]" : "w-3 bg-[#2A4A40]"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={back}
                  className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-[#c5d4cc] hover:bg-[#15221E]"
                >
                  Back
                </button>
              )}
              <button
                ref={nextRef}
                type="button"
                onClick={next}
                className="rounded-[8px] bg-[#14F195] px-6 py-2 text-[13px] font-semibold text-[#050807] hover:bg-[#3DFFB0]"
              >
                {last ? "Got it" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeskPreview({ region }: { region: DeskTourRegion }) {
  const hi = (id: DeskTourRegion) =>
    region === id
      ? "ring-2 ring-[#14F195] bg-[#14F195]/12"
      : "ring-1 ring-[#15221E] bg-[#070B0A] opacity-55";

  return (
    <div className="border-b border-[#1A2A26] bg-[#070B0A] px-5 pb-4">
      <div
        className="relative grid h-[188px] w-full gap-[3px] rounded-[10px] border border-[#15221E] bg-[#050807] p-1"
        style={{
          gridTemplateColumns: "132px minmax(0,1fr) 68px 76px",
          gridTemplateRows: "28px minmax(0,1fr) 32px",
          gridTemplateAreas: `"pair tape tape tape" "chart chart book ticket" "pos pos pos ticket"`,
        }}
      >
        <div style={{ gridArea: "pair" }} className={`flex items-center gap-1.5 rounded-[5px] px-1.5 ${hi("pair")}`}>
          <span className="h-3.5 w-3.5 rounded-full bg-[#F7931A]" />
          <span className="text-[9px] font-semibold text-[#f5f5f5]">BTC / USDC</span>
          <span className="text-[8px] text-[#7d8f88]">▾</span>
        </div>
        <div style={{ gridArea: "tape" }} className={`flex items-center gap-2 rounded-[5px] px-2 ${hi("tape")}`}>
          <span className="font-mono text-[9px] text-[#f5f5f5]">82,977.7</span>
          <span className="font-mono text-[8px] text-[#ff5c5c]">-2.19%</span>
          <span className="hidden font-mono text-[8px] text-[#8A9B94] sm:inline">Mark 82,978</span>
        </div>
        <div style={{ gridArea: "chart" }} className={`relative overflow-hidden rounded-[5px] ${hi("chart")}`}>
          <MiniCandles />
          <span className="absolute left-1.5 top-1 text-[8px] font-semibold uppercase tracking-[.08em] text-[#8A9B94]">
            Chart
          </span>
        </div>
        <div style={{ gridArea: "book" }} className={`flex flex-col justify-center gap-[2px] rounded-[5px] px-1 ${hi("book")}`}>
          {[0.9, 0.7, 0.5, 0.35].map((w, i) => (
            <span key={`a${i}`} className="ml-auto h-[3px] rounded-sm bg-[#ff5c5c]/80" style={{ width: `${w * 100}%` }} />
          ))}
          <span className="my-[1px] text-center font-mono text-[7px] text-[#f5f5f5]">82,978</span>
          {[0.4, 0.6, 0.8, 1].map((w, i) => (
            <span key={`b${i}`} className="h-[3px] rounded-sm bg-[#14F195]/80" style={{ width: `${w * 100}%` }} />
          ))}
        </div>
        <div style={{ gridArea: "ticket" }} className={`flex flex-col items-stretch justify-end gap-1 rounded-[5px] p-1.5 ${hi("ticket")}`}>
          <span className="rounded-[3px] bg-[#14F195] py-[3px] text-center text-[7px] font-semibold text-[#050807]">
            Long
          </span>
          <span className="rounded-[3px] bg-[#ff5c5c] py-[3px] text-center text-[7px] font-semibold text-white">
            Short
          </span>
        </div>
        <div style={{ gridArea: "pos" }} className={`flex items-center px-2 ${hi("pos")}`}>
          <span className="text-[8px] font-semibold uppercase tracking-[.08em] text-[#8A9B94]">
            Positions · Orders
          </span>
        </div>
        {region === "pair" && <MiniPairMenu />}
      </div>
    </div>
  );
}

function MiniCandles() {
  const bars = [8, 14, 10, 18, 12, 22, 16, 20, 11, 17, 24, 15];
  return (
    <svg viewBox="0 0 120 60" className="absolute inset-0 h-full w-full" aria-hidden>
      {bars.map((h, i) => {
        const up = i % 3 !== 1;
        return (
          <rect
            key={i}
            x={6 + i * 9}
            y={48 - h}
            width="5"
            height={h}
            rx="0.6"
            fill={up ? "#14F195" : "#ff5c5c"}
            opacity="0.85"
          />
        );
      })}
    </svg>
  );
}

function MiniPairMenu() {
  const rows = [
    ["BTC / USDC", true],
    ["ETH / USDC", false],
    ["SOL / USDC", false],
    ["TSLA / USDC", false],
  ] as const;
  return (
    <div className="absolute left-2 top-8 z-10 w-[132px] overflow-hidden rounded-[6px] border border-[#1A2A26] bg-[#0E1614] shadow-[0_12px_28px_rgba(0,0,0,.55)]">
      {rows.map(([label, on]) => (
        <div
          key={label}
          className={`flex items-center gap-1.5 px-2 py-1.5 text-[8px] ${
            on ? "bg-[#14F195]/15 text-[#14F195]" : "text-[#8A9B94]"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${on ? "bg-[#F7931A]" : "bg-[#2A4A40]"}`} />
          {label}
        </div>
      ))}
    </div>
  );
}
