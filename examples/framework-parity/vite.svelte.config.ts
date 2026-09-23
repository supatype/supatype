import { defineConfig } from "vite"

import { svelte } from "@sveltejs/vite-plugin-svelte"


// Each app builds to its own directory so all three can exist at once; `app.mode` serves whichever
// one `mode:svelte` last pointed at.
export default defineConfig({
  root: "src/svelte",
  plugins: [svelte()],
  build: { outDir: "../../dist/svelte", emptyOutDir: true },
})
