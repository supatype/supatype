import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Built to ./dist, which `app.mode: "static"` in the project config serves. The app and the API
// therefore share one origin: no CORS, no hardcoded host, one command to run the whole thing.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
})
