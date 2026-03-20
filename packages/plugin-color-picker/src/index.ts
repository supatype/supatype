import { defineWidget } from "@supatype/plugin-sdk"

export default defineWidget({
  name: "color-picker",
  label: "Colour Picker",
  compatibleTypes: ["text", "varchar"],
  componentPath: "./src/ColorPickerWidget.tsx",
})
