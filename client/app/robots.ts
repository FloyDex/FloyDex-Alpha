import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/admin/"],
    },
    host: "https://floydex.com",
    sitemap: "https://floydex.com/sitemap.xml",
  };
}
