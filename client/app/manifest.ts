import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FloyDex",
    short_name: "FloyDex",
    description: "Decentralised perpetual futures",
    start_url: "/",
    display: "standalone",
    background_color: "#070B0A",
    theme_color: "#14F195",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/favicon.png", type: "image/png", sizes: "48x48", purpose: "any" },
      { src: "/apple-icon.png", type: "image/png", sizes: "180x180", purpose: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
    ],
  };
}
