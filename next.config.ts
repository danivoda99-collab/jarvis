import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Codul punții merge împreună cu /api/punte, ca laptopul să se actualizeze singur.
  outputFileTracingIncludes: {
    "/api/punte": ["./bridge/argus-bridge.mjs", "./bridge/team-voda.mjs"],
  },
};

export default nextConfig;
