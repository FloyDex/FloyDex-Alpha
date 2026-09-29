"use client";

import { memo, useEffect, useId, useRef, useState } from "react";

// Renders TradingView's Advanced Chart (the real widget engine, loaded from
// tv.js). Data, indicators, drawing tools and chart types are all handled by
// TradingView itself, so this works regardless of the viewer's region.

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

const SCRIPT_ID = "tradingview-embed-script";
const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if (window.TradingView) return resolve();
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("tv.js failed to load")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("tv.js failed to load"));
    document.head.appendChild(s);
  });
}

// FloyDex dark palette, matched to the order ticket surface.
const BG = "#070B0A";
const GRID = "#25252B";
const SCALE_LINE = "#1A2A26";
const SCALE_TEXT = "#a3a3a3";
const UP = "#1fae5b";
const DOWN = "#e34c4c";

export const TradingViewWidget = memo(function TradingViewWidget({
  symbol,
  interval = "60",
  chartStyle = "1",
  extendedHours = false,
}: {
  // REQUIRED. This defaulted to "COINBASE:XLMUSD", so any caller that failed
  // to thread a symbol through charted XLM under another market's header.
  symbol: string;
  interval?: string;
  chartStyle?: string;
  extendedHours?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountId = `tv_${useId().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    setLoading(true);
    setError(null);
    host.innerHTML = "";
    const inner = document.createElement("div");
    inner.id = mountId;
    inner.style.width = "100%";
    inner.style.height = "100%";
    host.appendChild(inner);

    const loaderFallback = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 6000);

    loadScript()
      .then(() => {
        if (cancelled || !window.TradingView) return;
        const widget = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: extendedHours ? "America/New_York" : "Etc/UTC",
          theme: "dark",
          style: chartStyle,
          locale: "en",
          backgroundColor: BG,
          gridColor: GRID,
          toolbar_bg: BG,
          custom_css_url: `${window.location.origin}/tradingview-overrides.css`,
          enable_publishing: false,
          allow_symbol_change: false,
          hide_top_toolbar: false,
          hide_side_toolbar: false,
          hide_legend: false,
          hide_volume: false,
          volume_pane_size: "tiny",
          save_image: true,
          withdateranges: true,
          details: false,
          calendar: false,
          hide_date_ranges: false,
          extended_hours: extendedHours,
          sessionid: extendedHours ? "extended" : "regular",
          container_id: mountId,
          loading_screen: { backgroundColor: BG, foregroundColor: SCALE_TEXT },
          disabled_features: [
            "header_symbol_search",
            "use_localstorage_for_settings",
            "pre_post_market_sessions",
            "pre_post_market_price_line",
          ],
          enabled_features: [
            "header_widget",
            "header_indicators",
            "header_compare",
            "header_undo_redo",
            "header_screenshot",
            "header_fullscreen_button",
            "timeframes_toolbar",
            "adaptive_logo",
          ],
          overrides: {
            "paneProperties.background": BG,
            "paneProperties.backgroundType": "solid",
            "paneProperties.backgroundGradientStartColor": BG,
            "paneProperties.backgroundGradientEndColor": BG,
            "paneProperties.topMargin": 8,
            "paneProperties.bottomMargin": 6,
            "paneProperties.vertGridProperties.color": GRID,
            "paneProperties.horzGridProperties.color": GRID,
            "scalesProperties.backgroundColor": BG,
            "scalesProperties.lineColor": SCALE_LINE,
            "scalesProperties.textColor": SCALE_TEXT,
            "mainSeriesProperties.sessionId": extendedHours ? "extended" : "regular",
            // Keep extended-hours candles; hide the yellow/blue session bands.
            "backgrounds.preMarket.visible": false,
            "backgrounds.preMarket.transparency": 100,
            "backgrounds.preMarket.color": BG,
            "backgrounds.postMarket.visible": false,
            "backgrounds.postMarket.transparency": 100,
            "backgrounds.postMarket.color": BG,
            "backgrounds.outOfSession.visible": false,
            "backgrounds.outOfSession.transparency": 100,
            "backgrounds.outOfSession.color": BG,
            "vertlines.sessBreaks.visible": false,
            "mainSeriesProperties.candleStyle.upColor": UP,
            "mainSeriesProperties.candleStyle.downColor": DOWN,
            "mainSeriesProperties.candleStyle.borderUpColor": UP,
            "mainSeriesProperties.candleStyle.borderDownColor": DOWN,
            "mainSeriesProperties.candleStyle.wickUpColor": UP,
            "mainSeriesProperties.candleStyle.wickDownColor": DOWN,
          },
        });
        void widget;
        // tv.js advanced widget has no reliable onChartReady; drop the loader
        // shortly after construction (the iframe paints its own loader too).
        setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, 1200);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Chart failed to load");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(loaderFallback);
      if (host) host.innerHTML = "";
    };
  }, [symbol, interval, chartStyle, mountId, retryNonce, extendedHours]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 80);
    });
    ro.observe(host);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#070B0A]">
          {error ? (
            <div className="flex flex-col items-center gap-3">
              <span className="text-xs font-mono text-[#a3a3a3]">Chart unavailable</span>
              <span className="max-w-[260px] text-center text-[11px] text-[#737373]">{error}</span>
              <button
                onClick={() => setRetryNonce((v) => v + 1)}
                className="rounded-[6px] bg-[#070B0A] border border-[#1C332C] px-3 py-1.5 text-[11px] font-medium text-[#f5f5f5] hover:border-[#4a4a4a] transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 pointer-events-none">
              <div className="w-5 h-5 border-2 border-[#070B0A] border-t-[#a3a3a3] rounded-full animate-spin" />
              <span className="text-[#737373] text-xs font-mono">Loading chart…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
