import type { Config } from "tailwindcss"
import studioPreset from "./tailwind.preset.js"

const config: Config = {
  presets: [studioPreset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
}

export default config
