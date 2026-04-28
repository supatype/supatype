import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "path"

const isLibBuild = process.env.BUILD_MODE === "lib"

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: process.env.VITE_BASE_PATH ?? "/",
  build: isLibBuild
    ? {
        // Library build: consumable package for cloud studio / other hosts
        lib: {
          entry: resolve(__dirname, "src/index.ts"),
          formats: ["es"],
          fileName: "index",
        },
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
          external: [
            "react",
            "react-dom",
            "react/jsx-runtime",
            "react-router-dom",
            "@supatype/client",
          ],
        },
      }
    : {
        // App build: standalone SPA for self-hosted deployments
        outDir: "dist-app",
        emptyOutDir: true,
      },
  server: {
    port: 3002,
    open: false,
    // When SUPATYPE_PROXY_TARGET is set (injected by `supatype dev`), forward all
    // API paths to the backend server-side so the browser sees same-origin requests
    // and CORS is never triggered — regardless of the server's CORS policy.
    proxy: process.env.SUPATYPE_PROXY_TARGET
      ? {
          "/studio-config": { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/auth/":         { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/rest":          { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/storage":       { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/functions":     { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/sql":           { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true },
          "/realtime":      { target: process.env.SUPATYPE_PROXY_TARGET, changeOrigin: true, ws: true },
        }
      : {},
  },
})
