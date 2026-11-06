// Label, id and error wiring shared by the form controls (Input, Select, Textarea, Checkbox).
import React from "react"

type AriaInvalid = React.AriaAttributes["aria-invalid"]

/** The caller's props that the field wiring reads and then overrides on the control. */
export interface FieldAttrs {
  id?: string | undefined
  "aria-describedby"?: string | undefined
  "aria-invalid"?: AriaInvalid | undefined
}

/** The words around a control: its label and its error text. */
export interface FieldText {
  label: string | undefined
  error: string | undefined
}

/** A control's ids, and the attributes to spread on the native control after the caller's props. */
export interface Field extends FieldText {
  errorId: string | undefined
  control: { id: string; "aria-describedby": string | undefined; "aria-invalid": AriaInvalid | undefined }
}

/** The border, fill, text and focus ring every boxed control (Input, Select, Textarea) wears. */
export const FIELD_FRAME = [
  "rounded-lg border text-sm transition-colors",
  "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500",
  "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500",
  "focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500",
]

/** Added to {@link FIELD_FRAME} while the control has an error. */
export const FIELD_ERROR = "border-red-500 focus:border-red-500 focus:ring-red-500"

/** The caller's aria-describedby, with the error text's id added when there is an error. */
function describedBy(callerValue: string | undefined, errorId: string | undefined): string | undefined {
  const ids = [callerValue, errorId].filter((value) => value !== undefined && value !== "")
  return ids.length > 0 ? ids.join(" ") : undefined
}

/**
 * Ids and ARIA for one control. useId, not a slug of the label: two controls labelled the same
 * would share an id. A caller's `id` wins, and its aria-describedby is kept beside the error's.
 */
export function useField(attrs: FieldAttrs, text: FieldText): Field {
  const generatedId = React.useId()
  const id = attrs.id ?? generatedId
  const errorId = text.error ? `${id}-error` : undefined
  const invalid = attrs["aria-invalid"] ?? (text.error ? true : undefined)
  return { ...text, errorId, control: { id, "aria-describedby": describedBy(attrs["aria-describedby"], errorId), "aria-invalid": invalid } }
}

/** The field's label, pointing at its control, or nothing when it has none. */
export function FieldLabel({ field }: { field: Field }): React.ReactElement | null {
  if (!field.label) return null
  return (
    <label htmlFor={field.control.id} className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
      {field.label}
    </label>
  )
}

/** The field's error text, which the control names in aria-describedby, or nothing. */
export function FieldError({ field }: { field: Field }): React.ReactElement | null {
  if (!field.error) return null
  return <p id={field.errorId} className="text-sm text-red-500">{field.error}</p>
}

/** A label over its control over the error text: the layout of Input, Select and Textarea. */
export function FieldLayout({ field, children }: { field: Field; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel field={field} />
      {children}
      <FieldError field={field} />
    </div>
  )
}
