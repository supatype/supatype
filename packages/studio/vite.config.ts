import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: process.env.VITE_BASE_PATH ?? "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3002,
    open: false,
  },
})
