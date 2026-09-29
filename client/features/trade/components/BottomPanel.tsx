"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { getPositions } from "@/lib/solana/account";
import { useOrderReconciliation } from "@/features/trade/hooks/useOrderReconciliation";
import { PositionsTable } from "./PositionsTable";
import { OpenOrdersTable } from "./OpenOrdersTable";
import { OrderHistoryTable } from "./OrderHistoryTable";
import { TradeHistoryTable } from "./TradeHistoryTable";
import { FundingHistoryTable } from "./FundingHistoryTable";

type TabKey = "Positions" | "Open Orders" | "Trade History" | "Order History" | "Funding History";

export function BottomPanel() {
  useOrderReconciliation();
  const [activeTab, setActiveTab] = useState<TabKey>("Positions");
  const { address, connected } = useWalletStore();
  const allOrders = useLocalOrders((s) => s.orders);
  const prevFilled = useRef(0);

  // Shared positions query (same key as PositionsTable — cache hit, no double-fetch)
  const { data: allPositions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const positionCount = allPositions.length;
  const orderCount = allOrders.filter((o) => o.status === "pending").length;
  const orderHistoryCount = allOrders.length;
  const filledCount = allOrders.filter((o) => o.status === "filled").length;

  // After a fill lands in local order history, jump to Positions so the open
  // risk is obvious (Order History alone looks like "filled but no position").
  useEffect(() => {
    if (filledCount > prevFilled.current) setActiveTab("Positions");
    prevFilled.current = filledCount;
  }, [filledCount]);

  const TABS: { key: TabKey; count: number | null }[] = [
    { key: "Positions", count: positionCount },
    { key: "Open Orders", count: orderCount },
    { key: "Trade History", count: null },
    { key: "Order History", count: orderHistoryCount },
    { key: "Funding History", count: null },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#070B0A]">
      <div className="flex overflow-x-auto no-scrollbar border-b border-[#15221E]">
        {TABS.map(({ key, count }) => (
          <button
            key={key}
            className={`desk-tab shrink-0 whitespace-nowrap px-3.5 py-2.5 text-[12px] ${activeTab === key ? "is-on" : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {key}
            {count !== null && (
              <span className={`ml-1 font-normal ${count > 0 ? "text-[#14F195]" : "text-[#5C6E67]"}`}>
                ({count})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Fills the desktop strip height the user dragged to; scrolls if needed. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === "Positions" && <PositionsTable marketFilter="all" sideFilter="both" />}
        {activeTab === "Open Orders" && <OpenOrdersTable marketFilter="all" sideFilter="both" />}
        {activeTab === "Trade History" && <TradeHistoryTable marketFilter="all" />}
        {activeTab === "Order History" && <OrderHistoryTable marketFilter="all" sideFilter="both" />}
        {activeTab === "Funding History" && <FundingHistoryTable marketFilter="all" />}
      </div>
    </div>
  );
}
