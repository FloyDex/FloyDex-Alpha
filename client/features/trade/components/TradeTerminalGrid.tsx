"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AccountBar } from "@/features/trade/components/AccountBar";
import { BottomPanel } from "@/features/trade/components/BottomPanel";
import { MarketHeader } from "@/features/trade/components/MarketHeader";
import { OrderBook } from "@/features/trade/components/OrderBook";
import { OrderEntry } from "@/features/trade/components/OrderEntry";
import { TradeChart } from "@/features/trade/components/TradeChart";
import { SymbolDetails } from "@/features/trade/components/SymbolDetails";
import { MarketInfo } from "@/features/trade/components/MarketInfo";
import { ThesisFeed } from "@/features/trade/components/ThesisFeed";
import { LiquidationMap } from "@/features/trade/components/LiquidationMap";
import { AiAnalysisPanel } from "@/features/trade/components/AiAnalysisPanel";
import { AiSpark } from "@/features/trade/components/AiSpark";
import { DeskTour } from "@/features/trade/components/DeskTour";
import { useSignupGift } from "@/features/trade/hooks/useSignupGift";
import {
  BOTTOM_PANEL_DEFAULT,
  BOTTOM_PANEL_MIN,
  clampBottomPanelPx,
  useTradeSettings,
} from "@/stores/settings";
import type { MarketConfig } from "@/config";
import { DESK_TOUR_STEPS, type DeskTourRegion } from "@/lib/market/desk-tour";

type MobileTab = "chart" | "book" | "ticket" | "positions";

export function TradeTerminalGrid({ market }: { market: MarketConfig }) {
  const hideOrderBook = useTradeSettings((s) => s.hideOrderBook);
  const detailsOpen = useTradeSettings((s) => s.symbolDetailsOpen);
  const setSymbolDetailsOpen = useTradeSettings((s) => s.setSymbolDetailsOpen);
  const storedPosH = useTradeSettings((s) => s.bottomPanelPx);
  const storedExpandedH = useTradeSettings((s) => s.bottomPanelExpandedPx);
  const setBottomPanelPx = useTradeSettings((s) => s.setBottomPanelPx);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chart");
  const [chartTab, setChartTab] = useState<"chart" | "info" | "thesis" | "liq">("chart");
  const showLiqMap = market.kind !== "equity";
  const [aiOpen, setAiOpen] = useState(false);
  // `side` is lifted here so the mobile bottom bar can open the ticket pre-set
  // to long/short. OrderEntry falls back to its own state when not controlled.
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [posH, setPosH] = useState(() =>
    Number.isFinite(storedPosH) ? storedPosH : BOTTOM_PANEL_DEFAULT,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const lastExpanded = useRef(
    storedExpandedH > BOTTOM_PANEL_MIN + 8
      ? storedExpandedH
      : storedPosH > BOTTOM_PANEL_MIN + 8
        ? storedPosH
        : BOTTOM_PANEL_DEFAULT,
  );
  const dragging = useRef(false);
  useSignupGift({ autoClaim: true });

  useEffect(() => {
    if (dragging.current) return;
    if (!Number.isFinite(storedPosH)) return;
    setPosH(storedPosH);
    if (storedExpandedH > BOTTOM_PANEL_MIN + 8) lastExpanded.current = storedExpandedH;
    else if (storedPosH > BOTTOM_PANEL_MIN + 8) lastExpanded.current = storedPosH;
  }, [storedPosH, storedExpandedH]);

  useEffect(() => {
    const id = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 80);
    return () => window.clearTimeout(id);
  }, [detailsOpen, posH, chartTab]);

  useEffect(() => {
    if (!showLiqMap && chartTab === "liq") setChartTab("chart");
  }, [showLiqMap, chartTab]);

  // Symbol details is a side rail on desktop; on phones it covers the chart.
  // Close it whenever the user leaves the chart tab so Long/Short stay usable.
  useEffect(() => {
    if (mobileTab !== "chart" && detailsOpen) setSymbolDetailsOpen(false);
  }, [mobileTab, detailsOpen, setSymbolDetailsOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => {
      if (mq.matches && useTradeSettings.getState().symbolDetailsOpen) {
        setSymbolDetailsOpen(false);
      }
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [setSymbolDetailsOpen]);

  useEffect(() => {
    const onWinResize = () => {
      if (dragging.current) return;
      setPosH((h) => clampBottomPanelPx(h, terminalH()));
    };
    window.addEventListener("resize", onWinResize);
    return () => {
      window.removeEventListener("resize", onWinResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  // Desktop (lg+) grid template — applied only via `lg:` so it is inert on the
  // mobile flex-column stack. Both branches are written as literal class strings
  // so Tailwind's JIT can see them.
  const gridClasses = hideOrderBook
    ? "lg:grid lg:[grid-template-rows:auto_minmax(0,1fr)_var(--desk-pos-h,220px)] lg:[grid-template-columns:minmax(0,1fr)_332px] lg:[grid-template-areas:'info_ticket'_'chart_ticket'_'pos_ticket']"
    : "lg:grid lg:[grid-template-rows:auto_minmax(0,1fr)_var(--desk-pos-h,220px)] lg:[grid-template-columns:minmax(0,1fr)_272px_332px] lg:[grid-template-areas:'info_book_ticket'_'chart_book_ticket'_'pos_pos_ticket']";

  function terminalH() {
    return rootRef.current?.getBoundingClientRect().height ?? 800;
  }

  function applyPosH(next: number, persist: boolean) {
    const clamped = clampBottomPanelPx(next, terminalH());
    setPosH(clamped);
    if (clamped > BOTTOM_PANEL_MIN + 8) lastExpanded.current = clamped;
    if (persist) setBottomPanelPx(clamped);
  }

  function onPosPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startY = e.clientY;
    const startH = posH;
    let latest = startH;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        dragging.current = true;
        handle.setPointerCapture(pointerId);
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
      }
      latest = clampBottomPanelPx(startH + (startY - ev.clientY), terminalH());
      setPosH(latest);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) applyPosH(latest, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // Mobile panel visibility (display:none keeps panels — and the chart iframe —
  // mounted so switching tabs never re-initialises websockets or the chart).
  const vis = (tab: MobileTab) => (mobileTab === tab ? "flex" : "hidden");

  const tabs: { key: MobileTab; label: string }[] = [
    { key: "chart", label: "Chart" },
    ...(hideOrderBook ? [] : [{ key: "book" as const, label: "Order Book" }]),
    { key: "ticket", label: "Trade" },
    { key: "positions", label: "Positions" },
  ];

  const onTourRegion = useCallback(
    (region: DeskTourRegion) => {
      const tab = DESK_TOUR_STEPS.find((s) => s.id === region)?.mobileTab;
      if (!tab) return;
      if (tab === "book" && hideOrderBook) setMobileTab("chart");
      else setMobileTab(tab);
    },
    [hideOrderBook],
  );

  return (
    <div
      ref={rootRef}
      className={`relative flex min-h-0 flex-1 flex-col ${gridClasses}`}
      style={{ ["--desk-pos-h" as string]: `${posH}px` }}
    >
      {/* ── Market header (info) — sticky at the top on mobile ── */}
      <div
        style={{ gridArea: "info" }}
        className="sticky top-0 z-20 lg:static lg:z-auto"
      >
        <MarketHeader
          market={market}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setSymbolDetailsOpen(!detailsOpen)}
        />
      </div>

      {/* ── Mobile tab switcher (hidden on desktop) ── */}
      <div className="sticky top-[48px] z-10 flex shrink-0 border-b border-[#15221E] bg-[#070B0A] lg:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setMobileTab(t.key)}
            className={`desk-tab flex-1 py-2.5 text-[12px] ${mobileTab === t.key ? "is-on" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Chart / Info ── */}
      <div
        style={{ gridArea: "chart" }}
        className={`${vis("chart")} min-h-0 flex-1 flex-col overflow-hidden max-lg:pb-[68px] lg:flex lg:h-full`}
      >
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[#15221E] bg-[#070B0A] px-2">
          <div className="flex h-full items-center">
            {([
              ["chart", "Chart"],
              ["info", "Info"],
              ["thesis", "Thesis"],
              ...(showLiqMap ? ([["liq", "Liq Map"]] as const) : []),
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setChartTab(id)}
                className={`desk-tab h-full px-3 text-[12px] ${chartTab === id ? "is-on" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={aiOpen}
            aria-label="AI analysis"
            onClick={() => setAiOpen((v) => !v)}
            className={`desk-chip ${aiOpen ? "is-on" : ""}`}
          >
            <AiSpark active={aiOpen} size={14} />
            AI
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {/* Keep the TV iframe painted (not display:none / visibility:hidden).
              Overlay tabs sit on top with an opaque background so the widget
              keeps receiving resize + realtime ticks. */}
          <div className="absolute inset-0 flex">
            <div
              className={`overflow-hidden transition-[width] duration-300 ease-out lg:h-full lg:shrink-0 ${
                detailsOpen
                  ? "absolute inset-0 z-20 flex flex-col bg-[#070B0A] max-lg:pb-[68px] lg:static lg:z-auto lg:w-[260px] lg:bg-transparent lg:pb-0"
                  : "hidden lg:block lg:w-0"
              }`}
            >
              <div className="h-full w-full min-h-0 lg:w-[260px]">
                <SymbolDetails market={market} onClose={() => setSymbolDetailsOpen(false)} />
              </div>
            </div>
            <div className="h-full min-h-0 min-w-0 flex-1">
              <TradeChart market={market} showQuickOrder={chartTab === "chart"} />
            </div>
          </div>
          <div className={`absolute inset-0 z-10 bg-[#070B0A] ${chartTab === "info" ? "flex" : "hidden"}`}>
            <MarketInfo market={market} />
          </div>
          <div className={`absolute inset-0 z-10 bg-[#070B0A] ${chartTab === "thesis" ? "flex" : "hidden"}`}>
            <ThesisFeed market={market} />
          </div>
          <div className={`absolute inset-0 z-10 bg-[#070B0A] ${chartTab === "liq" && showLiqMap ? "flex" : "hidden"}`}>
            {showLiqMap ? <LiquidationMap market={market} /> : null}
          </div>
        </div>
      </div>

      {/* ── Order book ── */}
      {!hideOrderBook && (
        <div
          style={{ gridArea: "book" }}
        className={`${vis("book")} min-h-0 flex-1 flex-col overflow-hidden border-[#15221E] bg-[#070B0A] lg:flex lg:h-auto lg:border-l`}
        >
          <OrderBook market={market} />
        </div>
      )}

      {/* ── Order ticket ── */}
      <div
        style={{ gridArea: "ticket" }}
        className={`${vis("ticket")} relative min-h-0 flex-1 flex-col overflow-y-auto border-[#15221E] bg-[#070B0A] pb-[max(16px,env(safe-area-inset-bottom))] lg:flex lg:overflow-y-auto lg:border-l lg:pb-0`}
      >
        <AccountBar />
        <OrderEntry market={market} side={side} setSide={setSide} />
      </div>

      {/* ── Positions / open orders / history ── */}
      <div
        style={{ gridArea: "pos" }}
        className={`${vis("positions")} relative min-h-0 flex-1 flex-col overflow-hidden border-[#15221E] max-lg:pb-[68px] lg:flex lg:h-full lg:border-t`}
      >
        <button
          type="button"
          aria-label="Resize positions panel"
          title="Drag to resize · double-click to collapse"
          onPointerDown={onPosPointerDown}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (posH > BOTTOM_PANEL_MIN + 8) {
              lastExpanded.current = posH;
              applyPosH(BOTTOM_PANEL_MIN, true);
            } else {
              applyPosH(lastExpanded.current || BOTTOM_PANEL_DEFAULT, true);
            }
          }}
          className="group absolute inset-x-0 -top-1 z-20 hidden h-3 cursor-ns-resize touch-none items-start justify-center lg:flex"
        >
          <span className="mt-1 h-[3px] w-11 rounded-full bg-[#2A4A40] transition-colors group-hover:bg-[#14F195] group-active:bg-[#14F195]" />
        </button>
        <BottomPanel />
      </div>

      {aiOpen && (
        <>
          <button
            type="button"
            aria-label="Close AI analysis"
            onClick={() => setAiOpen(false)}
            className="absolute inset-0 z-40 bg-black/45"
          />
          <AiAnalysisPanel market={market} onClose={() => setAiOpen(false)} />
        </>
      )}
      {mobileTab !== "ticket" && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 gap-2 border-t border-[#15221E] bg-[#070B0A]/92 px-3 pt-2.5 backdrop-blur-md lg:hidden"
          style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={() => { setSide("buy"); setMobileTab("ticket"); }}
            className="desk-btn-long rounded-[8px] py-2.5 text-[13px] font-semibold"
          >
            Open Long
          </button>
          <button
            onClick={() => { setSide("sell"); setMobileTab("ticket"); }}
            className="desk-btn-short rounded-[8px] py-2.5 text-[13px] font-semibold"
          >
            Open Short
          </button>
        </div>
      )}
      <DeskTour onRegion={onTourRegion} />
    </div>
  );
}
