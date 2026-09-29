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

const EXTERNAL_LINKS = [{ label: "Docs", href: GITHUB_REPO }];

function TelegramIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.458.02.889-.16 1.844-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function XLogoIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.227-8.451L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

const iconBtn =
  "inline-flex h-[34px] w-[34px] items-center justify-center rounded-[7px] text-[#a3a3a3] transition-colors hover:bg-[#070B0A] hover:text-[#f5f5f5]";

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

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* Guide stays desktop-only; Telegram + X sit beside it on every width. */}
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
          <a
            href={TELEGRAM}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Telegram"
            title="Telegram"
            className={iconBtn}
          >
            <TelegramIcon />
          </a>
          <a
            href={X_HANDLE}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X"
            title="X"
            className={iconBtn}
          >
            <XLogoIcon />
          </a>
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
