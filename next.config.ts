import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Saved preset results are read from disk at run time, so they must ship with the function.
  outputFileTracingIncludes: {
    "/api/check": ["./data/cache/**/*"],
  },
};

export default nextConfig;
