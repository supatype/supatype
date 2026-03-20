import type { WidgetProps } from "@supatype/plugin-sdk"

const E164_REGEX = /^\+\d{7,15}$/

function normaliseToE164(input: string): string {
  // Strip spaces and dashes
  let normalised = input.replace(/[\s\-()]/g, "")
  // Ensure + prefix
  if (!normalised.startsWith("+") && normalised.length > 0) {
    normalised = "+" + normalised
  }
  return normalised
}

export default function PhoneWidget(props: WidgetProps<string>) {
  const { value, onChange, disabled, errors } = props
  const displayValue = value ?? ""

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === "") {
      onChange(null)
      return
    }
    const normalised = normaliseToE164(raw)
    onChange(normalised)
  }

  const isValid = displayValue === "" || E164_REGEX.test(displayValue)
  const showError = !isValid && displayValue !== ""

  return (
    <div>
      <input
        type="tel"
        value={displayValue}
        onChange={handleChange}
        placeholder="+44 7911 123456"
        disabled={disabled}
        style={{
          borderColor: showError ? "red" : undefined,
        }}
      />
      {showError && (
        <span style={{ color: "red", fontSize: "0.85em" }}>
          Invalid E.164 format (e.g. +447911123456)
        </span>
      )}
      {errors.length > 0 && errors.map((err: string, i: number) => (
        <span key={i} style={{ color: "red", fontSize: "0.85em", display: "block" }}>
          {err}
        </span>
      ))}
    </div>
  )
}
