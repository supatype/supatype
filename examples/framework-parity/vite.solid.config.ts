import { defineConfig } from "vite"


import solid from "vite-plugin-solid"

// Each app builds to its own directory so all three can exist at once; `app.mode` serves whichever
// one `mode:solid` last pointed at.
export default defineConfig({
  root: "src/solid",
  plugins: [solid()],
  build: { outDir: "../../dist/solid", emptyOutDir: true },
})
