import { useState } from "react"
import { getWidgetsForType } from "./WidgetRegistry.js"
import { WidgetLoader } from "./WidgetLoader.js"

// -- Props -------------------------------------------------------------------

export interface CompositeField {
  name: string
  type: string
  value: unknown
  onChange: (v: unknown) => void
}

export interface CompositeFieldGroupProps {
  compositeName: string
  label: string
  fields: CompositeField[]
  collapsible?: boolean | undefined
  defaultCollapsed?: boolean | undefined
}

// -- Default field input -----------------------------------------------------

function DefaultFieldInput(props: {
  name: string
  type: string
  value: unknown
  onChange: (v: unknown) => void
}): React.JSX.Element {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    if (props.type === "number" || props.type === "integer") {
      props.onChange(raw === "" ? null : Number(raw))
    } else if (props.type === "boolean") {
      props.onChange(e.target.checked)
    } else {
      props.onChange(raw)
    }
  }

  if (props.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={Boolean(props.value)}
        onChange={handleChange}
        aria-label={props.name}
      />
    )
  }

  return (
    <input
      type={props.type === "number" || props.type === "integer" ? "number" : "text"}
      value={typeof props.value === "string" || typeof props.value === "number"
        ? String(props.value)
        : ""}
      onChange={handleChange}
      aria-label={props.name}
      style={{ width: "100%", boxSizing: "border-box" }}
    />
  )
}

// -- Component ---------------------------------------------------------------

/**
 * Renders a composite's fields as a (optionally collapsible) group. Each
 * field is rendered through the widget system when a compatible plugin
 * widget exists, otherwise a plain default input is used.
 */
export function CompositeFieldGroup(
  props: CompositeFieldGroupProps,
): React.JSX.Element {
  const { compositeName, label, fields } = props
  const collapsible = props.collapsible ?? true
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false)

  const toggleCollapsed = (): void => {
    if (collapsible) setCollapsed((prev) => !prev)
  }

  return (
    <fieldset
      style={{ border: "1px solid #333", borderRadius: 4, padding: 0 }}
      aria-label={compositeName}
    >
      <legend style={{ padding: "0 8px" }}>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          style={{
            background: "none",
            border: "none",
            cursor: collapsible ? "pointer" : "default",
            fontWeight: 600,
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {collapsible && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                transition: "transform 150ms",
                transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              }}
            >
              &#x25BE;
            </span>
          )}
          {label}
        </button>
      </legend>

      {!collapsed && (
        <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
          {fields.map((field) => {
            const widgets = getWidgetsForType(field.type)
            const widget = widgets[0]

            return (
              <div key={field.name}>
                <label
                  htmlFor={`${compositeName}-${field.name}`}
                  style={{ display: "block", marginBottom: 4, fontSize: 13 }}
                >
                  {field.name}
                </label>

                {widget ? (
                  <WidgetLoader
                    pluginName={widget.pluginName}
                    componentPath={widget.componentPath}
                    value={field.value}
                    onChange={field.onChange}
                    fieldName={field.name}
                    fieldType={field.type}
                    config={{}}
                    errors={[]}
                  />
                ) : (
                  <DefaultFieldInput
                    name={field.name}
                    type={field.type}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
