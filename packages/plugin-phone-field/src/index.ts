import { defineFieldType } from "@supatype/plugin-sdk"

const E164_REGEX = /^\+\d{7,15}$/

export default defineFieldType<string>({
  name: "phone",
  pgType: "TEXT",
  tsType: "string",

  validate(value: unknown): string | null {
    if (typeof value !== "string") return "Must be a string"
    if (!E164_REGEX.test(value)) return "Invalid phone number (E.164 format required: +, then 7-15 digits)"
    return null
  },

  serialise(value: string): unknown {
    // Strip all non-digit characters except the leading +
    const stripped = value.startsWith("+")
      ? "+" + value.slice(1).replace(/\D/g, "")
      : "+" + value.replace(/\D/g, "")
    return stripped
  },

  deserialise(raw: unknown): string {
    return String(raw)
  },

  filterOperators: ["eq", "neq", "in", "like"],
  widgetPath: "./src/PhoneWidget.tsx",
  constraints: [`CHECK ("$COLUMN" ~ '^\\+[0-9]{7,15}$')`],
})
