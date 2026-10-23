import { useState } from "react"
import { getWidgetsForType } from "./WidgetRegistry.js"
import { WidgetLoader } from "./WidgetLoader.js"
import { Checkbox, DisclosureButton, Input } from "../components/ui.js"

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
  id: string
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
    return <Checkbox id={props.id} label={null} checked={Boolean(props.value)} onChange={handleChange} aria-label={props.name} />
  }

  return (
    <Input
      id={props.id}
      type={props.type === "number" || props.type === "integer" ? "number" : "text"}
      value={typeof props.value === "string" || typeof props.value === "number"
        ? String(props.value)
        : ""}
      onChange={handleChange}
      aria-label={props.name}
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
    <fieldset className="rounded-md border border-border" aria-label={compositeName}>
      <legend className="px-2">
        {/* A group that cannot collapse has nothing to disclose, so its header claims no state. */}
        <DisclosureButton
          open={collapsible ? !collapsed : undefined}
          onClick={toggleCollapsed}
          className="w-auto gap-1.5 rounded-sm px-1 text-sm font-semibold text-foreground"
        >
          {collapsible && (
            <span aria-hidden="true" className={collapsed ? "inline-block -rotate-90 transition-transform" : "inline-block transition-transform"}>
              &#x25BE;
            </span>
          )}
          {label}
        </DisclosureButton>
      </legend>

      {!collapsed && (
        <div className="flex flex-col gap-3 px-3 py-2">
          {fields.map((field) => {
            const widgets = getWidgetsForType(field.type)
            const widget = widgets[0]

            return (
              <div key={field.name}>
                <label htmlFor={`${compositeName}-${field.name}`} className="mb-1 block text-[13px] text-muted-foreground">
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
                    id={`${compositeName}-${field.name}`}
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
