import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

// Built to ./dist, which `app.mode: "static"` in the project config serves. The app and the API
// therefore share one origin: no CORS, no hardcoded host, one command to run the whole thing.
//
// The production build carries no anon key: index.html loads `/supatype-env.js` from the server
// that serves the page, and the client reads it from there. `envDir` is the project root because
// that is where `supatype keys` and `dev` write the local stack's values (`.env.development.local`),
// which a dev build reads; Vite's default is its own root.
export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true },
})
