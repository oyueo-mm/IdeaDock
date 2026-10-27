import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "IdeaDock · 아이디어가 머무는 곳",
  description: "빠르게 기록하고, 차근차근 완성하는 나만의 아이디어 작업 공간.",
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
