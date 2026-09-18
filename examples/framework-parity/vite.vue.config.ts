import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"



// Each app builds to its own directory so all three can exist at once; `app.mode` serves whichever
// one `mode:vue` last pointed at.
export default defineConfig({
  root: "src/vue",
  plugins: [vue()],
  build: { outDir: "../../dist/vue", emptyOutDir: true },
})
