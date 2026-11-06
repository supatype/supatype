import React from "react"
import { clsx } from "clsx"
import { FieldError, FieldLabel, useField } from "./field.js"

/** A native checkbox, so `checked`, `defaultChecked` and `onChange` work as they do on `<input>`. */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string
  error?: string
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, className, ...props }, ref) => {
    const field = useField(props, { label, error })
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={ref}
            type="checkbox"
            {...props}
            {...field.control}
            className={clsx(
              "h-4 w-4 shrink-0 rounded accent-purple-600 disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2",
              error && "outline outline-1 outline-offset-1 outline-red-500",
              className,
            )}
          />
          <FieldLabel field={field} />
        </div>
        <FieldError field={field} />
      </div>
    )
  },
)
Checkbox.displayName = "Checkbox"
