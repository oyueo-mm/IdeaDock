import type { Metadata, Viewport } from "next";
import "./globals.css";
// Metadata icon URLs are not prefixed with next.config basePath; the manifest
// link is generated from app/manifest.ts and is prefixed automatically.
export const metadata: Metadata = {
  title: "IdeaDock · 아이디어가 머무는 곳",
  description: "빠르게 기록하고, 차근차근 완성하는 나만의 아이디어 작업 공간.",
  applicationName: "IdeaDock",
  icons: {
    icon: [
      { url: "/IdeaDock/icons/icon.svg", type: "image/svg+xml" },
      {
        url: "/IdeaDock/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: "/IdeaDock/icons/apple-touch-icon.png",
  },
};
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#18181b" },
  ],
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
