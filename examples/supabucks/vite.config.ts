import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Built to ./dist and served statically by Supatype (app.mode: "static").
// Served at the gateway root, so the default base "/" is correct.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
})
