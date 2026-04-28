import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Transpile workspace packages so Next.js can import them directly
  transpilePackages: ["@supatype/client", "@supatype/react", "@supatype/react-auth", "@supatype/ssr"],
}

export default nextConfig
