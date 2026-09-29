"use client"

import { FloyDexChart } from '@/features/chart/components/FloyDexChart'
import { QuickMarketBar } from '@/features/trade/components/QuickMarketBar'
import type { MarketConfig } from '@/config'

interface Props {
  /**
   * The full market config. Previously this took `symbol` plus an optional
   * `marketId` defaulting to 1, so any caller that forgot to pass one silently
   * charted XLM-PERP's position and orders over another market's candles.
   */
  market: MarketConfig
  /** Quick-order overlay is chart-only so Info / Thesis / Liq Map stay readable. */
  showQuickOrder?: boolean
}

export function TradeChart({ market, showQuickOrder = true }: Props) {
  return (
    <div className="relative h-full min-h-0">
      <FloyDexChart
        symbol={market.tvSymbol}
        marketSymbol={market.symbol}
        extendedHours={market.kind === "equity"}
      />
      {showQuickOrder ? <QuickMarketBar market={market} /> : null}
    </div>
  )
}
