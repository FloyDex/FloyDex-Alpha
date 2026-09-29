import type { Metadata, Viewport } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "@/components/common/Providers";
import { networkFromCookies } from "@/lib/network-server";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  // `|| fallback` (not ??): an EMPTY NEXT_PUBLIC_APP_URL is defined but makes
  // new URL("") throw ERR_INVALID_URL and kill the whole build.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://floydex.com"),
  title: "FloyDex | Tokenized PerpDex",
  description: "Decentralised perpetual futures on Solana — tokenized-stock and crypto perps, USDC-settled",
  applicationName: "FloyDex",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "48x48" },
      { url: "/icon.png", type: "image/png", sizes: "64x64" },
      { url: "/favicon.ico", sizes: "48x48", type: "image/x-icon" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    shortcut: "/favicon.ico",
  },
  openGraph: {
    title: "FloyDex | Tokenized PerpDex",
    description: "Decentralised perpetual futures on Solana",
    siteName: "FloyDex",
    url: "https://floydex.com",
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
  twitter: {
    card: "summary",
    site: "@floydex_com",
    creator: "@floydex_com",
    title: "FloyDex | Tokenized PerpDex",
    description: "Decentralised perpetual futures on Solana",
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#070B0A",
  width: "device-width",
  initialScale: 1,
  // Allow pinch-zoom for accessibility; iOS input auto-zoom is prevented via a
  // 16px min font-size on inputs in globals.css instead of locking the scale.
  maximumScale: 5,
  // Extend the canvas under the iOS notch / home indicator; pair with safe-area
  // padding utilities (.pt-safe / .pb-safe) so content stays clear of insets.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the cookie opts this layout into request-time rendering, which is
  // required and intended: the chrome differs per selected network.
  const network = await networkFromCookies();

  return (
    <html lang="en" className={`${poppins.variable} ${geistMono.variable} dark h-full`}>
      <body className="min-h-dvh bg-[#070B0A] text-[#f5f5f5] antialiased">
        <Providers network={network}>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
