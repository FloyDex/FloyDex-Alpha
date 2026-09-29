import { ACTIVE_MARKETS } from "@/config";
import { TopNav } from "@/components/common/TopNav";
import { MarketsTable } from "@/features/trade/components/MarketsTable";

export const metadata = {
  title: "Markets — FloyDex",
  description: "Active perpetual markets available for trading on FloyDex.",
};

export default function MarketsPage() {
  const markets = Object.values(ACTIVE_MARKETS);

  return (
    <main
      className="min-h-screen bg-[#070B0A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <section className="mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">Markets</h1>
            <p className="mt-1 text-[13px] text-[#6b7c74]">
              Tokenized stock and crypto perps, settled in USDC.
            </p>
          </div>
          <p className="text-[12px] tabular text-[#6b7c74]">
            {markets.length} perps · {markets.filter((m) => m.kind === "equity").length} equities ·{" "}
            {markets.filter((m) => m.kind !== "equity").length} crypto
          </p>
        </div>

        <MarketsTable markets={markets} />
      </section>
    </main>
  );
}
