import { DEFAULT_MARKET_SYMBOL } from "@/config";
import { redirect } from "next/navigation";

export default function TradeIndexPage() {
  redirect(`/trade/${DEFAULT_MARKET_SYMBOL}`);
}
