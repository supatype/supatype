import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const gateway = process.env.VITE_SUPATYPE_URL?.replace(/\/$/, "") || "http://127.0.0.1:18473"

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly — default "localhost" is often ::1-only on Windows,
    // so Docker (host.docker.internal → 127.0.0.1) gets connection refused → Kong 502.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost", "host.docker.internal"],
    // If you open Vite directly (:5173), forward API paths to Kong.
    proxy: {
      "/functions": gateway,
      "/auth": gateway,
      "/rest": gateway,
      "/realtime": { target: gateway, ws: true },
      "/storage": gateway,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
})
