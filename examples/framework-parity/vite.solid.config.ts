import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { sharedConfig } from "./vite.shared"

// Each app builds to its own directory so all three can exist at once; `app.mode` serves whichever
// one `mode:solid` last pointed at.
export default defineConfig(({ mode }) => ({
  ...sharedConfig(mode),
  root: "src/solid",
  plugins: [solid()],
  build: { outDir: "../../dist/solid", emptyOutDir: true },
}))
