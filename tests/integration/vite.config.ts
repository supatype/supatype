import { defineConfig, loadEnv } from "vite"

/** Dedicated port — default 5173 is often taken by other local Vite apps. */
const APP_DEV_PORT = 5174

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const kongPort = env.SUPATYPE_KONG_PORT ?? "18473"
  return {
    server: {
      host: "127.0.0.1",
      port: APP_DEV_PORT,
      strictPort: true,
      /** Compose proxies via host.docker.internal; Kong uses localhost:<kongPort>. */
      allowedHosts: ["127.0.0.1", "localhost", "host.docker.internal"],
      origin: `http://localhost:${kongPort}`,
    },
    envPrefix: ["VITE_"],
    define: {
      "import.meta.env.VITE_SUPATYPE_ANON_KEY": JSON.stringify(env.VITE_SUPATYPE_ANON_KEY ?? ""),
    },
  }
})
