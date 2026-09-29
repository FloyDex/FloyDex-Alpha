"use client"

import { useChartStore } from '@/stores/chart'
import { TradingViewWidget } from './TradingViewWidget'

interface Props {
  /** TradingView symbol, e.g. "COINBASE:BTCUSD". */
  symbol: string
  /** Market symbol ("BTC-PERP") — the key for per-market view state. */
  marketSymbol: string
  extendedHours?: boolean
}

// FloyDex timeframe → TradingView interval
const TV_INTERVAL: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W',
}
// FloyDex chart type → TradingView style
const TV_STYLE: Record<string, string> = {
  candles: '1', bars: '0', line: '2', area: '3',
}

export function FloyDexChart({
  symbol,
  marketSymbol,
  extendedHours = false,
}: Props) {
  // Per-market view state — a timeframe change on one market must not reset
  // another's. Subscribing to the map keeps this reactive across switches.
  const views = useChartStore((s) => s.views)
  const view = views[marketSymbol] ?? { timeframe: '1h' as const, chartType: 'candles' as const }
  const tvInterval = TV_INTERVAL[view.timeframe] ?? '60'
  const tvStyle = TV_STYLE[view.chartType] ?? '1'

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#070B0A]">
      <div className="relative min-h-0 flex-1">
        <TradingViewWidget
          symbol={symbol}
          interval={tvInterval}
          chartStyle={tvStyle}
          extendedHours={extendedHours}
        />
      </div>
    </div>
  )
}
