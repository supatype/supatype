import React from "react"
import { clsx } from "clsx"
import { FIELD_ERROR, FIELD_FRAME, FieldLayout, useField } from "./field.js"

/** A native `<select>`: pass `<option>` (and `<optgroup>`) elements as children. */
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, className, children, ...props }, ref) => {
    const field = useField(props, { label, error })
    return (
      <FieldLayout field={field}>
        <select
          ref={ref}
          {...props}
          {...field.control}
          className={clsx("h-10 px-3", FIELD_FRAME, error && FIELD_ERROR, className)}
        >
          {children}
        </select>
      </FieldLayout>
    )
  },
)
Select.displayName = "Select"
