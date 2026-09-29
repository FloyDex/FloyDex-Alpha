"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SettingKey = 'hidePnl' | 'hideLiqPrice' | 'hideOrderBook' | 'animateOrderBook' | 'skipOrderConfirms'

interface TradeSettings {
  hidePnl: boolean
  hideLiqPrice: boolean
  hideOrderBook: boolean
  degenMode: boolean
  animateOrderBook: boolean
  skipOrderConfirms: boolean
  favoriteSymbols: string[]
  symbolDetailsOpen: boolean
  popularTickerHidden: boolean
  aiPanelWidth: number
  aiPanelHeightPct: number
  bottomPanelPx: number
  bottomPanelExpandedPx: number
  deskTourDone: boolean
  /** Bump to force-open the desk guide (not persisted). */
  deskTourKick: number
  ticketLeverage: number
  /** Shared with QuickMarketBar — not persisted. */
  ticketSize: string
  /** base = asset qty, quote = notional USDC, margin = collateral USDC. */
  ticketSizeMode: "base" | "quote" | "margin"
  quickMarketHidden: boolean
  quickMarketPx: number
  quickMarketX: number | null
  quickMarketY: number | null
  setDegenMode: (v: boolean) => void
  setSymbolDetailsOpen: (v: boolean) => void
  setPopularTickerHidden: (v: boolean) => void
  setAiPanelSize: (width: number, heightPct: number) => void
  setBottomPanelPx: (px: number) => void
  setDeskTourDone: (v: boolean) => void
  requestDeskTour: () => void
  setTicketLeverage: (v: number) => void
  setTicketSize: (v: string) => void
  setTicketSizeMode: (v: "base" | "quote" | "margin") => void
  setQuickMarketHidden: (v: boolean) => void
  setQuickMarketPx: (px: number) => void
  setQuickMarketPos: (x: number | null, y: number | null) => void
  toggleFavorite: (symbol: string) => void
  toggle: (k: SettingKey) => void
  reset: () => void
}

const DEFAULTS = {
  hidePnl: false,
  hideLiqPrice: false,
  hideOrderBook: false,
  degenMode: false,
  animateOrderBook: true,
  skipOrderConfirms: false,
  favoriteSymbols: [] as string[],
  symbolDetailsOpen: true,
  popularTickerHidden: false,
  aiPanelWidth: 380,
  aiPanelHeightPct: 100,
  bottomPanelPx: 220,
  bottomPanelExpandedPx: 220,
  deskTourDone: false,
  deskTourKick: 0,
  ticketLeverage: 15,
  ticketSize: "",
  ticketSizeMode: "base" as const,
  quickMarketHidden: false,
  quickMarketPx: 520,
  quickMarketX: null as number | null,
  quickMarketY: null as number | null,
}

export const BOTTOM_PANEL_MIN = 48
export const BOTTOM_PANEL_DEFAULT = 220
export const QUICK_MARKET_MIN = 360
export const QUICK_MARKET_MAX = 860
export const QUICK_MARKET_DEFAULT = 520

export function clampQuickMarketPx(px: number): number {
  const n = Number.isFinite(px) ? px : QUICK_MARKET_DEFAULT
  return Math.round(Math.max(QUICK_MARKET_MIN, Math.min(QUICK_MARKET_MAX, n)))
}

const QM_PAD = 8

export function defaultQuickMarketPos(barW: number, viewW: number, viewH: number): { x: number; y: number } {
  const w = Math.min(barW, Math.max(QM_PAD * 2, viewW - QM_PAD * 2))
  return {
    x: Math.round((viewW - w) / 2),
    y: Math.round(viewH * 0.36),
  }
}

export function clampQuickMarketPos(
  x: number,
  y: number,
  barW: number,
  barH: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const w = Math.min(Math.max(1, barW), Math.max(QM_PAD * 2, viewW - QM_PAD * 2))
  const h = Math.max(32, barH)
  return {
    x: Math.round(Math.max(QM_PAD, Math.min(Math.max(QM_PAD, viewW - w - QM_PAD), x))),
    y: Math.round(Math.max(QM_PAD, Math.min(Math.max(QM_PAD, viewH - h - QM_PAD), y))),
  }
}

export function clampBottomPanelPx(px: number, terminalH: number): number {
  const n = Number.isFinite(px) ? px : BOTTOM_PANEL_DEFAULT
  const max = Math.max(BOTTOM_PANEL_MIN, Math.round(terminalH * 0.72))
  return Math.round(Math.max(BOTTOM_PANEL_MIN, Math.min(max, n)))
}

export const useTradeSettings = create<TradeSettings>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDegenMode: (v) => set({ degenMode: v }),
      setSymbolDetailsOpen: (v) => set({ symbolDetailsOpen: v }),
      setPopularTickerHidden: (v) => set({ popularTickerHidden: v }),
      setAiPanelSize: (width, heightPct) =>
        set((s) =>
          s.aiPanelWidth === width && s.aiPanelHeightPct === heightPct
            ? s
            : { aiPanelWidth: width, aiPanelHeightPct: heightPct },
        ),
      setBottomPanelPx: (px) =>
        set((s) => {
          const expanded = px > BOTTOM_PANEL_MIN + 8 ? px : s.bottomPanelExpandedPx
          if (s.bottomPanelPx === px && s.bottomPanelExpandedPx === expanded) return s
          return { bottomPanelPx: px, bottomPanelExpandedPx: expanded }
        }),
      setDeskTourDone: (v) => set({ deskTourDone: v }),
      requestDeskTour: () => set((s) => ({ deskTourDone: false, deskTourKick: s.deskTourKick + 1 })),
      setTicketLeverage: (v) => {
        const n = Math.round(Number(v))
        if (!Number.isFinite(n)) return
        set({ ticketLeverage: Math.max(1, n) })
      },
      setTicketSize: (v) => set((s) => (s.ticketSize === v ? s : { ticketSize: v })),
      setTicketSizeMode: (v) =>
        set((s) => (s.ticketSizeMode === v ? s : { ticketSizeMode: v })),
      setQuickMarketHidden: (v) => set({ quickMarketHidden: v }),
      setQuickMarketPx: (px) => {
        const next = clampQuickMarketPx(px)
        set((s) => (s.quickMarketPx === next ? s : { quickMarketPx: next }))
      },
      setQuickMarketPos: (x, y) =>
        set((s) => (s.quickMarketX === x && s.quickMarketY === y ? s : { quickMarketX: x, quickMarketY: y })),
      toggleFavorite: (symbol) =>
        set((s) => ({
          favoriteSymbols: s.favoriteSymbols.includes(symbol)
            ? s.favoriteSymbols.filter((x) => x !== symbol)
            : [...s.favoriteSymbols, symbol],
        })),
      toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<TradeSettings>),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: "floydex-settings",
      version: 13,
      partialize: (s) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(s)) {
          if (typeof v === "function") continue
          if (k === "ticketSize" || k === "ticketSizeMode" || k === "deskTourKick") continue
          out[k] = v
        }
        return out as typeof DEFAULTS
      },
      migrate: (persisted, version) => {
        const prev = (persisted ?? {}) as Record<string, unknown>
        const prevPx = Number(prev.bottomPanelPx)
        const fromQuote = prev.ticketSizeInQuote === true
        return {
          ...DEFAULTS,
          ...prev,
          ticketSize: "",
          ticketSizeMode: fromQuote ? "quote" : "base",
          ...(version < 2 ? { symbolDetailsOpen: true } : {}),
          ...(version < 3 ? { popularTickerHidden: false } : {}),
          ...(version < 4 ? { aiPanelWidth: 380, aiPanelHeightPct: 100 } : {}),
          ...(version < 5 ? { aiPanelHeightPct: 100, aiPanelWidth: 380 } : {}),
          ...(version < 6 ? { bottomPanelPx: BOTTOM_PANEL_DEFAULT } : {}),
          ...(version < 7
            ? {
                bottomPanelExpandedPx:
                  Number.isFinite(prevPx) && prevPx > BOTTOM_PANEL_MIN + 8
                    ? prevPx
                    : BOTTOM_PANEL_DEFAULT,
              }
            : {}),
          // Returning users already know the desk — don't force the new-user tour.
          ...(version < 8 ? { deskTourDone: true } : {}),
          ...(version < 9 ? { ticketLeverage: 15, quickMarketHidden: false } : {}),
          ...(version < 10 ? { quickMarketPx: QUICK_MARKET_DEFAULT } : {}),
          ...(version < 11 ? { quickMarketX: null, quickMarketY: null } : {}),
          ...(version < 13
            ? { ticketSizeMode: fromQuote ? "quote" : DEFAULTS.ticketSizeMode }
            : {}),
        }
      },
    }
  )
)
