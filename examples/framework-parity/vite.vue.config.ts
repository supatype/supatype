import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { sharedConfig } from "./vite.shared"

// Each app builds to its own directory so all three can exist at once; `app.mode` serves whichever
// one `mode:vue` last pointed at.
export default defineConfig(({ mode }) => ({
  ...sharedConfig(mode),
  root: "src/vue",
  plugins: [vue()],
  build: { outDir: "../../dist/vue", emptyOutDir: true },
}))
