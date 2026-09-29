import { ACTIVE_MARKETS, DEFAULT_MARKET_SYMBOL } from "@/config";
import { redirect } from "next/navigation";
import { MarketDataProvider } from "@/features/trade/components/MarketDataProvider";
import { SettlementModal } from "@/features/trade/components/SettlementModal";
import { TopNav } from "@/components/common/TopNav";
import { TradeTerminalGrid } from "@/features/trade/components/TradeTerminalGrid";

export default async function TradePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  const marketConfig = ACTIVE_MARKETS[market.toUpperCase()];
  if (!marketConfig) redirect(`/trade/${DEFAULT_MARKET_SYMBOL}`);

  return (
    <MarketDataProvider market={marketConfig}>
      <SettlementModal />

      {/* Fixed-height terminal on every breakpoint so the chart / book / ticket
          panels can share the remaining viewport. Inner panels scroll. */}
      <div
        className="flex h-dvh flex-col overflow-hidden"
        style={{ background: "#070B0A", fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        <TopNav />
        <TradeTerminalGrid market={marketConfig} />
      </div>
    </MarketDataProvider>
  );
}
