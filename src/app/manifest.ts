import type { MetadataRoute } from "next";

export const dynamic = "force-static";

// Manifest URLs are not rewritten with next.config basePath, so they carry the
// GitHub Pages repository path explicitly. The id keeps IdeaDock distinct from
// other apps on oyueo-mm.github.io (e.g. /TransitLog/).
const base = "/IdeaDock/";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: base,
    name: "IdeaDock",
    short_name: "IdeaDock",
    description:
      "빠르게 기록하고, 차근차근 완성하는 나만의 아이디어 작업 공간.",
    lang: "ko",
    start_url: base,
    scope: base,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: `${base}icons/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${base}icons/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${base}icons/maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
