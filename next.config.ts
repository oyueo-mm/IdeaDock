import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  basePath: "/IdeaDock",
  trailingSlash: true,
  images: { unoptimized: true },
};
export default config;
