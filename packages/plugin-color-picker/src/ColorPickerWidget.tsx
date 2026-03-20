import type { WidgetProps } from "@supatype/plugin-sdk"

const HEX_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function expandHex(hex: string): string {
  if (hex.length === 4) {
    // #RGB -> #RRGGBB
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  }
  return hex
}

export default function ColorPickerWidget(props: WidgetProps<string>) {
  const { value, onChange, disabled, errors } = props
  const displayValue = value ?? "#000000"

  const isValid = HEX_REGEX.test(displayValue)
  // The native color input needs a 7-char hex value
  const colorInputValue = isValid ? expandHex(displayValue) : "#000000"

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === "") {
      onChange(null)
      return
    }
    onChange(raw)
  }

  const showError = displayValue !== "" && !isValid

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <input
        type="color"
        value={colorInputValue}
        onChange={handleColorChange}
        disabled={disabled}
        style={{ width: 40, height: 40, padding: 0, border: "1px solid #ccc", cursor: "pointer" }}
      />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <input
          type="text"
          value={displayValue}
          onChange={handleTextChange}
          placeholder="#RRGGBB"
          disabled={disabled}
          style={{
            fontFamily: "monospace",
            borderColor: showError ? "red" : undefined,
          }}
        />
        {showError && (
          <span style={{ color: "red", fontSize: "0.85em" }}>
            Invalid hex format (use #RGB or #RRGGBB)
          </span>
        )}
        {errors.length > 0 && errors.map((err: string, i: number) => (
          <span key={i} style={{ color: "red", fontSize: "0.85em" }}>
            {err}
          </span>
        ))}
      </div>
    </div>
  )
}
