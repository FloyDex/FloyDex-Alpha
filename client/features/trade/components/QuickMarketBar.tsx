"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu, X } from "lucide-react";
import { toast } from "sonner";
import type { MarketConfig } from "@/config";
import { formatMarketPrice } from "@/lib/format";
import { sanitizeQuickSize, sizeFromBuyingPowerPct } from "@/lib/market/quick-market";
import { usePlaceMarketOrder } from "@/features/trade/hooks/usePlaceMarketOrder";
import {
  clampQuickMarketPos,
  clampQuickMarketPx,
  defaultQuickMarketPos,
  QUICK_MARKET_DEFAULT,
  useTradeSettings,
} from "@/stores/settings";

const PRESETS = [
  { id: "s", label: "Compact", px: 400 },
  { id: "m", label: "Default", px: QUICK_MARKET_DEFAULT },
  { id: "l", label: "Large", px: 680 },
] as const;

function viewSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function QuickMarketBar({ market }: { market: MarketConfig }) {
  const hidden = useTradeSettings((s) => s.quickMarketHidden);
  const setHidden = useTradeSettings((s) => s.setQuickMarketHidden);
  const storedPx = useTradeSettings((s) => s.quickMarketPx);
  const setStoredPx = useTradeSettings((s) => s.setQuickMarketPx);
  const storedX = useTradeSettings((s) => s.quickMarketX);
  const storedY = useTradeSettings((s) => s.quickMarketY);
  const setStoredPos = useTradeSettings((s) => s.setQuickMarketPos);
  const { place, loading, lastPrice, availableHuman, leverage, connected } = usePlaceMarketOrder(market);
  const size = useTradeSettings((s) => s.ticketSize);
  const setSize = useTradeSettings((s) => s.setTicketSize);
  const sizeMode = useTradeSettings((s) => s.ticketSizeMode);
  const setSizeMode = useTradeSettings((s) => s.setTicketSizeMode);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number } | null>(null);
  /** First click arms buy/sell; second click within 3s places — stops fat-finger fills. */
  const [armSide, setArmSide] = useState<"buy" | "sell" | null>(null);
  const [width, setWidth] = useState(() => clampQuickMarketPx(storedPx));
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 8, y: 8 };
    const { w, h } = viewSize();
    const def = defaultQuickMarketPos(clampQuickMarketPx(storedPx), w, h);
    if (storedX == null || storedY == null) return def;
    return clampQuickMarketPos(storedX, storedY, clampQuickMarketPx(storedPx), 56, w, h);
  });
  const [ready, setReady] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const resizing = useRef(false);
  const skipMenuClick = useRef(false);
  const posRef = useRef(pos);
  const widthRef = useRef(width);
  posRef.current = pos;
  widthRef.current = width;

  useEffect(() => setReady(true), []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (resizing.current) return;
    setWidth(clampQuickMarketPx(storedPx));
  }, [storedPx]);

  useEffect(() => {
    if (moving.current) return;
    if (typeof window === "undefined") return;
    const { w, h } = viewSize();
    const barH = barRef.current?.offsetHeight ?? 56;
    if (storedX == null || storedY == null) {
      setPos(defaultQuickMarketPos(width, w, h));
      return;
    }
    setPos(clampQuickMarketPos(storedX, storedY, width, barH, w, h));
  }, [storedX, storedY, width]);

  useEffect(() => {
    function onResize() {
      if (moving.current || resizing.current) return;
      const { w, h } = viewSize();
      const barH = barRef.current?.offsetHeight ?? 56;
      setPos((p) => clampQuickMarketPos(p.x, p.y, width, barH, w, h));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (menuBtnRef.current?.contains(t) || menuPanelRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  function toggleMenu() {
    if (skipMenuClick.current) {
      skipMenuClick.current = false;
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (!r) {
      setMenuOpen(true);
      return;
    }
    const menuH = 280;
    const menuW = 176;
    const placeBelow = window.innerHeight - r.bottom > menuH + 12;
    const top = placeBelow ? r.bottom + 6 : r.top - menuH - 6;
    const left = Math.min(r.left, window.innerWidth - menuW - 8);
    setMenuBox({ top: Math.max(8, top), left: Math.max(8, left) });
    setMenuOpen(true);
  }

  const unit =
    sizeMode === "base" ? market.baseAsset : sizeMode === "quote" ? market.quoteAsset : "Margin";
  const px = lastPrice > 0 ? formatMarketPrice(market, lastPrice) : "—";
  const scale = Math.max(0.78, Math.min(1.55, width / QUICK_MARKET_DEFAULT));

  useEffect(() => {
    if (!armSide) return;
    const t = window.setTimeout(() => setArmSide(null), 3_000);
    return () => window.clearTimeout(t);
  }, [armSide]);

  function fillPct(pct: number) {
    if (!connected) {
      setSize("");
      return;
    }
    const next = sizeFromBuyingPowerPct({
      availableHuman,
      leverage,
      pct,
      execPrice: lastPrice,
      sizeMode,
    });
    if (!next) return;
    setSize(next);
    setMenuOpen(false);
  }

  async function onSide(side: "buy" | "sell") {
    if (!(parseFloat(size) > 0)) {
      toast.error("Enter an amount first");
      return;
    }
    if (armSide !== side) {
      setArmSide(side);
      return;
    }
    setArmSide(null);
    const ok = await place(side, size, sizeMode);
    if (ok) setSize("");
  }

  function applyWidth(next: number, persist: boolean) {
    const clamped = clampQuickMarketPx(next);
    setWidth(clamped);
    if (persist) setStoredPx(clamped);
  }

  function resetPlace() {
    const { w, h } = viewSize();
    const next = defaultQuickMarketPos(width, w, h);
    setPos(next);
    setStoredPos(null, null);
    setMenuOpen(false);
  }

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-qm-nodrag]")) return;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startPos = posRef.current;
      let latest = startPos;
      let moved = false;
      const fromMenu = Boolean(menuBtnRef.current?.contains(e.target as Node));
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved) {
          if (Math.hypot(dx, dy) < 4) return;
          moved = true;
          moving.current = true;
          setGrabbing(true);
          setMenuOpen(false);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        const { w, h } = viewSize();
        const barH = barRef.current?.offsetHeight ?? 56;
        latest = clampQuickMarketPos(startPos.x + dx, startPos.y + dy, widthRef.current, barH, w, h);
        setPos(latest);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        moving.current = false;
        setGrabbing(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (moved) {
          if (fromMenu) skipMenuClick.current = true;
          setStoredPos(latest.x, latest.y);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [ready, hidden, setStoredPos]);

  function onResizePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        resizing.current = true;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* synthetic / test events */
        }
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
      }
      const maxW = Math.max(QUICK_MARKET_DEFAULT / 2, window.innerWidth - pos.x - 8);
      latest = clampQuickMarketPx(Math.min(maxW, startW + (ev.clientX - startX)));
      setWidth(latest);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) applyWidth(latest, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  if (!ready || isMobile) return null;

  if (hidden) {
    return createPortal(
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="fixed z-[60] rounded-[8px] border border-[#1A2A26] bg-[#0E1614]/90 px-3 py-1.5 text-[11px] font-semibold text-[#c5d4cc] shadow-[0_8px_24px_rgba(0,0,0,.45)] backdrop-blur-sm hover:text-[#f5f5f5]"
        style={{ left: pos.x, top: pos.y }}
      >
        Quick order
      </button>,
      document.body,
    );
  }

  const labelPx = Math.round(9 * scale);
  const titlePx = Math.round(11 * scale);
  const pricePx = Math.round(11 * scale);
  const amountPx = Math.round(13 * scale);
  const padY = Math.round(6 * scale);
  const amountW = Math.round(118 * scale);

  return createPortal(
    <div
      ref={barRef}
      className={`fixed z-[60] ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: `min(${width}px, calc(100vw - 16px))`,
      }}
    >
      <div
        className="relative flex items-stretch rounded-[10px] border border-[#1A2A26] bg-[#0E1614]/92 shadow-[0_16px_40px_rgba(0,0,0,.55)] backdrop-blur-md"
        style={{ gap: Math.round(4 * scale), padding: Math.round(4 * scale) }}
      >
        <div className="relative">
          <button
            ref={menuBtnRef}
            type="button"
            aria-label="Quick order options"
            aria-expanded={menuOpen}
            title="Drag to move · click for options"
            onClick={toggleMenu}
            className="grid h-full cursor-grab place-items-center rounded-[7px] text-[#8A9B94] hover:bg-[#15221E] hover:text-[#f5f5f5] active:cursor-grabbing"
            style={{ minWidth: Math.round(32 * scale) }}
          >
            <Menu size={Math.round(15 * scale)} />
          </button>
          {menuOpen &&
            createPortal(
              <div
                ref={menuPanelRef}
                className="z-[80] w-[176px] overflow-hidden rounded-[10px] border border-[#1A2A26] bg-[#0E1614] py-1 shadow-[0_12px_28px_rgba(0,0,0,.55)]"
                style={{ position: "fixed", top: menuBox?.top ?? 8, left: menuBox?.left ?? 8 }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSizeMode("base");
                    setMenuOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                    sizeMode === "base" ? "text-[#14F195]" : "text-[#c5d4cc] hover:bg-[#15221E]"
                  }`}
                >
                  Amount ({market.baseAsset})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSizeMode("quote");
                    setMenuOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                    sizeMode === "quote" ? "text-[#14F195]" : "text-[#c5d4cc] hover:bg-[#15221E]"
                  }`}
                >
                  Notional ({market.quoteAsset})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSizeMode("margin");
                    setMenuOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                    sizeMode === "margin" ? "text-[#14F195]" : "text-[#c5d4cc] hover:bg-[#15221E]"
                  }`}
                >
                  Margin ({market.quoteAsset})
                </button>
                <div className="my-1 h-px bg-[#1A2A26]" />
                <div className="px-3 pb-1 text-[10px] uppercase tracking-[.08em] text-[#6b7c74]">Size</div>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      applyWidth(p.px, true);
                      setMenuOpen(false);
                    }}
                    className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                      Math.abs(width - p.px) < 8 ? "text-[#14F195]" : "text-[#c5d4cc] hover:bg-[#15221E]"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={resetPlace}
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-[#c5d4cc] hover:bg-[#15221E]"
                >
                  Reset place
                </button>
                <div className="my-1 h-px bg-[#1A2A26]" />
                <div className="grid grid-cols-4 gap-0.5 px-2 pb-1.5 pt-0.5">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => fillPct(pct)}
                      className="rounded-[5px] py-1 font-mono text-[10px] text-[#8A9B94] hover:bg-[#15221E] hover:text-[#f5f5f5]"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )}
        </div>

        <button
          type="button"
          data-qm-nodrag
          disabled={loading}
          onClick={() => void onSide("buy")}
          className={`desk-btn-long min-w-0 flex-1 cursor-pointer rounded-[8px] disabled:opacity-50 ${
            armSide === "buy" ? "ring-2 ring-[#14F195] ring-offset-1 ring-offset-[#0E1614]" : ""
          }`}
          style={{ padding: `${padY}px ${Math.round(8 * scale)}px` }}
        >
          <span className="block font-semibold leading-tight" style={{ fontSize: titlePx }}>
            {armSide === "buy" ? "Tap again to buy" : "Market buy"}
          </span>
          <span className="block font-mono leading-tight tabular" style={{ fontSize: pricePx }}>
            {px}
          </span>
        </button>

        <label
          data-qm-nodrag
          className="flex shrink-0 cursor-text flex-col justify-center"
          style={{ width: amountW, paddingLeft: Math.round(8 * scale), paddingRight: Math.round(8 * scale) }}
        >
          <span
            className="font-medium uppercase tracking-[.04em] text-[#6b7c74]"
            style={{ fontSize: labelPx }}
          >
            Amount({unit})
          </span>
          <input
            value={size}
            onChange={(e) => {
              setArmSide(null);
              setSize(sanitizeQuickSize(e.target.value));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder="Enter Here"
            inputMode="decimal"
            className="w-full bg-transparent font-mono text-[#f5f5f5] outline-none placeholder:text-[#4a5c56]"
            style={{ fontSize: amountPx }}
          />
        </label>

        <button
          type="button"
          data-qm-nodrag
          disabled={loading}
          onClick={() => void onSide("sell")}
          className={`desk-btn-short min-w-0 flex-1 cursor-pointer rounded-[8px] disabled:opacity-50 ${
            armSide === "sell" ? "ring-2 ring-[#FF5C6A] ring-offset-1 ring-offset-[#0E1614]" : ""
          }`}
          style={{ padding: `${padY}px ${Math.round(8 * scale)}px` }}
        >
          <span className="block font-semibold leading-tight" style={{ fontSize: titlePx }}>
            {armSide === "sell" ? "Tap again to sell" : "Market sell"}
          </span>
          <span className="block font-mono leading-tight tabular" style={{ fontSize: pricePx }}>
            {px}
          </span>
        </button>

        <button
          type="button"
          data-qm-nodrag
          aria-label="Hide quick order"
          onClick={() => setHidden(true)}
          className="grid cursor-pointer place-items-center rounded-[7px] text-[#8A9B94] hover:bg-[#15221E] hover:text-[#f5f5f5]"
          style={{ minWidth: Math.round(32 * scale) }}
        >
          <X size={Math.round(15 * scale)} />
        </button>

        <button
          type="button"
          data-qm-nodrag
          aria-label="Resize quick order"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizePointerDown}
          onDoubleClick={(e) => {
            e.preventDefault();
            applyWidth(QUICK_MARKET_DEFAULT, true);
          }}
          className="absolute -right-1 top-0 bottom-0 z-10 w-3 cursor-ew-resize touch-none"
        >
          <span className="absolute right-[3px] top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full bg-[#2A4A40]" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
