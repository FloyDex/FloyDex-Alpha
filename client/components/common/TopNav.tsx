"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CircleHelp, Menu, X } from "lucide-react";
import { FloyDexLogo } from "@/components/common/FloyDexLogo";
import { WalletConnect } from "@/features/wallet/components/WalletConnect";
import { NotificationBell } from "@/features/navbar/components/NotificationBell";
import { SettingsMenu } from "@/features/navbar/components/SettingsMenu";
import { FuturesDrawerLinks, FuturesMenu } from "@/features/navbar/components/FuturesMenu";
import { PopularTicker } from "@/features/navbar/components/PopularTicker";
import { STAKE_PUBLIC } from "@/lib/market/stake";
import { DEFAULT_MARKET_SYMBOL } from "@/config";
import { useTradeSettings } from "@/stores/settings";

const GITHUB_REPO = "https://github.com/FloyDex/FloyDex-Alpha";
const TELEGRAM = "https://t.me/floydex_com";
const X_HANDLE = "https://x.com/floydex_com";

const TABS = [
  { label: "Markets", href: "/markets", match: "/markets" },
  { label: "Portfolio", href: "/portfolio", match: "/portfolio" },
  ...(STAKE_PUBLIC ? [{ label: "Stake", href: "/stake", match: "/stake" }] : []),
  { label: "Leaderboard", href: "/leaderboard", match: "/leaderboard" },
];

const EXTERNAL_LINKS = [
  { label: "Docs", href: GITHUB_REPO },
  { label: "Telegram", href: TELEGRAM },
  { label: "X", href: X_HANDLE },
];

export function TopNav() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const requestDeskTour = useTradeSettings((s) => s.requestDeskTour);

  function openDeskGuide() {
    requestDeskTour();
    if (!pathname.startsWith("/trade")) {
      router.push(`/trade/${DEFAULT_MARKET_SYMBOL}?tour=1`);
    }
  }

  return (
    <header
      className="relative z-40 shrink-0 border-b border-[#15221E] bg-[#0B1210]"
      style={{ paddingTop: "max(6px, env(safe-area-inset-top))" }}
    >
      <div className="flex items-center justify-between gap-1.5 px-2.5 py-[6px] sm:gap-2 sm:px-[14px]">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-[12px]">
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] text-[#a3a3a3] transition-colors hover:bg-[#070B0A] hover:text-[#f5f5f5] md:hidden"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>

          <Link href="/" className="flex shrink-0 items-center gap-[6px] select-none sm:gap-[8px]">
            <FloyDexLogo size={26} className="text-[#14F195]" />
            <span
              className="hidden text-[18px] font-bold text-[#f5f5f5] sm:inline"
              style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
            >
              FLOYDEX
            </span>
          </Link>

          <nav className="hidden items-center md:flex">
            <FuturesMenu />
            {TABS.map((t) => {
              const active = pathname.startsWith(t.match);
              return (
                <Link
                  key={t.label}
                  href={t.href}
                  className={`desk-tab px-3 py-2 text-[13px] ${active ? "is-on" : ""}`}
                >
                  {t.label}
                </Link>
              );
            })}
            {EXTERNAL_LINKS.map((t) => (
              <a
                key={t.label}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className="desk-tab px-3 py-2 text-[13px]"
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-[10px]">
          {/* Guide lives in the mobile drawer — keep the header lean on phones. */}
          <button
            type="button"
            onClick={openDeskGuide}
            aria-label="Desk guide"
            title="Desk guide"
            className="hidden h-[34px] items-center gap-1.5 rounded-[7px] px-2.5 text-[#a3a3a3] transition-colors hover:bg-[#070B0A] hover:text-[#f5f5f5] md:inline-flex"
          >
            <CircleHelp size={15} />
            <span className="text-[12px] font-medium">Guide</span>
          </button>
          <WalletConnect />
          <NotificationBell />
          <SettingsMenu />
        </div>
      </div>

      <PopularTicker />

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="absolute inset-x-0 top-full z-50 border-b border-[#1A2A26] bg-[#0E1614] p-2 shadow-[0_20px_40px_rgba(0,0,0,.5)] md:hidden">
            <FuturesDrawerLinks onNavigate={() => setMenuOpen(false)} />
            {TABS.map((t) => {
              const active = pathname.startsWith(t.match);
              return (
                <Link
                  key={t.label}
                  href={t.href}
                  onClick={() => setMenuOpen(false)}
                  className={`block rounded-[8px] px-4 py-3 text-[15px] font-medium transition-colors ${
                    active
                      ? "bg-[#070B0A] text-[#f5f5f5]"
                      : "text-[#a3a3a3] hover:bg-[#070B0A] hover:text-[#f5f5f5]"
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
            {EXTERNAL_LINKS.map((t) => (
              <a
                key={t.label}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuOpen(false)}
                className="block rounded-[8px] px-4 py-3 text-[15px] font-medium text-[#a3a3a3] transition-colors hover:bg-[#070B0A] hover:text-[#f5f5f5]"
              >
                {t.label}
              </a>
            ))}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDeskGuide();
              }}
              className="mt-1 flex w-full items-center gap-2 rounded-[8px] px-4 py-3 text-left text-[15px] font-medium text-[#a3a3a3] transition-colors hover:bg-[#070B0A] hover:text-[#f5f5f5]"
            >
              <CircleHelp size={16} />
              Desk guide
            </button>
          </nav>
        </>
      )}
    </header>
  );
}
