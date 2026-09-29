import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampAiHeightPct,
  clampAiWidth,
  clampChatHistory,
  classifyHeadline,
  fearClass,
  greedFromChange,
  localBullets,
  meterFromTechnicals,
  parseAnalysisPayload,
  parseLlmJson,
  sanitizeQuestion,
  stanceFromTechnicals,
  expandBulletText,
  stripDeskEmoji,
} from "./ai-analysis";

test("fear class bands match a CEX greed meter", () => {
  assert.equal(fearClass(12), "Extreme Fear");
  assert.equal(fearClass(40), "Fear");
  assert.equal(fearClass(50), "Neutral");
  assert.equal(fearClass(74), "Greed");
  assert.equal(fearClass(88), "Extreme Greed");
});

test("greedFromChange maps a flat tape to 50", () => {
  assert.equal(greedFromChange(0), 50);
  assert.ok(greedFromChange(8) > 70);
  assert.ok(greedFromChange(-8) < 30);
});

test("headlines classify without mixing both sides", () => {
  assert.equal(classifyHeadline("ETF inflows hit a record"), "bull");
  assert.equal(classifyHeadline("Whales dump into a crash"), "bear");
  assert.equal(classifyHeadline("Tesla reports quarterly results"), "skip");
});

test("local bullets use 24h change and thesis posts", () => {
  const out = localBullets({
    base: "BTC",
    price: 82751,
    changePct: -2.35,
    high: 85119,
    low: 82170,
    fundingRate: 0.02,
    volumeUsd: 1.7e9,
    news: ["Spot ETF inflows hit a record"],
    longPosts: ["holding the 82k bid"],
    shortPosts: ["range fade into 85k"],
  });
  assert.ok(out.bearish.some((b) => b.text.includes("down 2.35%")));
  assert.ok(out.bullish.some((b) => /inflow|record/i.test(b.text)));
  assert.ok([...out.bullish, ...out.bearish].every((b) => !/[\u{1F300}-\u{1FAFF}]/u.test(b.text)));
});

test("parseLlmJson pulls an object out of a fenced reply", () => {
  const parsed = parseLlmJson('Sure.\n```json\n{"summary":"BTC faded the high.","stance":"bearish","bullish":["Held the 82k bid"],"bearish":["Lost the 85k offer"]}\n```');
  const payload = parseAnalysisPayload(parsed, { long: 2, short: 3 });
  assert.equal(payload?.stance, "bearish");
  assert.equal(payload?.bullish[0]?.posts, 0);
  assert.equal(stripDeskEmoji(payload?.bullish[0]?.text ?? ""), payload?.bullish[0]?.text);
  assert.doesNotMatch(payload?.bullish[0]?.text ?? "", /[\u{1F300}-\u{1FAFF}]/u);
  assert.match(payload?.summary ?? "", /faded/i);
});

test("chat helpers reject junk and clamp history", () => {
  assert.equal(sanitizeQuestion("  hi  "), "hi");
  assert.equal(sanitizeQuestion("x"), null);
  assert.equal(clampChatHistory([{ role: "user", content: "levels?" }]).length, 1);
  assert.equal(clampAiWidth(10), 300);
  assert.equal(clampAiHeightPct(200), 100);
});

test("equity technicals drive the AI meter instead of 24h fear", () => {
  assert.equal(stanceFromTechnicals("Strong buy"), "bullish");
  assert.equal(stanceFromTechnicals("Selling"), "bearish");
  const meter = meterFromTechnicals(1, "Strong buy");
  assert.equal(meter.kind, "technicals");
  assert.equal(meter.value, 100);
  assert.equal(meter.label, "Strong buy");
});

test("equity volume bullets cite shares, not dollar volume", () => {
  const out = localBullets({
    base: "TSLA",
    price: 372.11,
    changePct: -1.54,
    high: 386.83,
    low: 367.67,
    fundingRate: 0,
    volumeUsd: 17.13e9,
    volumeShares: 45.93e6,
    equity: true,
    news: [],
    longPosts: [],
    shortPosts: [],
  });
  const texts = [...out.bullish, ...out.bearish].map((b) => b.text).join(" ");
  assert.match(texts, /45\.93M shares/);
  assert.match(texts, /\$17\.13B notional/);
  assert.doesNotMatch(texts, /Funding/);
  assert.match(texts, /holding .* above the 24h low/);
});

test("concatenated emoji bullets split into separate rows", () => {
  const parts = expandBulletText(
    "📈 Last 372.11 is above SMA20. 📈 RSI 64 is bullish. 📈 Strong buy on the panel.",
    "bull",
  );
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "Last 372.11 is above SMA20.");
  const parsed = parseAnalysisPayload({
    summary: "Tesla last 372.11 is a pullback inside a strong buy.",
    stance: "bullish",
    bullish: [
      "📈 Last price (372.11) sits above SMA20. 📈 24-hour high of 386.83 is unused upside. 📈 Technicals are strong buy.",
    ],
    bearish: ["📉 24h change is -1.54%."],
  });
  assert.ok(parsed);
  assert.equal(parsed!.bullish.length, 3);
  assert.equal(parsed!.bearish.length, 1);
  assert.equal(parsed!.bullish[0]?.posts, 0);
  assert.doesNotMatch(parsed!.bullish.map((b) => b.text).join(" "), /[\u{1F300}-\u{1FAFF}]/u);
});

test("tape bullets do not invent a post count", () => {
  const out = localBullets({
    base: "TSLA",
    price: 372.11,
    changePct: -1.54,
    high: 386.83,
    low: 367.67,
    fundingRate: 0,
    volumeUsd: 17.13e9,
    volumeShares: 45.93e6,
    equity: true,
    news: [],
    longPosts: [],
    shortPosts: [],
  });
  assert.ok([...out.bullish, ...out.bearish].every((b) => b.posts === 0));
});
