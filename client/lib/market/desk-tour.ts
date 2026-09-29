export type DeskTourRegion = "pair" | "tape" | "chart" | "book" | "ticket" | "pos";

export type DeskTourStep = {
  id: DeskTourRegion;
  title: string;
  body: string;
  mobileTab?: "chart" | "book" | "ticket" | "positions";
};

export const DESK_TOUR_STEPS: DeskTourStep[] = [
  {
    id: "pair",
    title: "1. Choosing a trading pair",
    body: "Choosing a pair is the first step before you start trading. Click the pair in the upper left. After you pick one, the chart, order book, and ticket all switch to that market.",
    mobileTab: "chart",
  },
  {
    id: "tape",
    title: "2. Reading the tape",
    body: "Last price, 24h change, mark, high, low, and volume sit next to the pair. The green dot means the feed is live. These figures are the same venue the chart uses.",
    mobileTab: "chart",
  },
  {
    id: "chart",
    title: "3. Chart and info",
    body: "The center pane is the live chart. Info and Thesis share that slot. Crypto perps also have a liquidation map. AI opens a short analysis for the market you are on.",
    mobileTab: "chart",
  },
  {
    id: "book",
    title: "4. Order book",
    body: "Bids are on the buy side, asks on the sell side. Click a price to load it into the ticket. Depth and recent trades sit in this column.",
    mobileTab: "book",
  },
  {
    id: "ticket",
    title: "5. Placing an order",
    body: "Set size and leverage on the right, then Open Long or Open Short. Connect a wallet in the header first. New accounts get a $5 credit — withdraw after $500 profit.",
    mobileTab: "ticket",
  },
  {
    id: "pos",
    title: "6. Positions and orders",
    body: "Open positions, working orders, and history live under the chart. Drag the handle to resize the strip, double-click to collapse it.",
    mobileTab: "positions",
  },
];
