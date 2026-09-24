import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

// Built to ./dist, which `app.mode: "static"` in the project config serves. The app and the API
// therefore share one origin: no CORS, no hardcoded host, one command to run the whole thing.
//
// `envDir` is the project root because that is where `supatype keys` writes
// VITE_SUPATYPE_ANON_KEY. Vite's default is its own root, so without this the build reads no .env
// at all and ships `anonKey: undefined`: a bundle that looks fine and is rejected by the gateway
// on every request.
export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true },
})
