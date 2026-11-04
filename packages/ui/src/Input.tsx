import React from "react"
import { clsx } from "clsx"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

/** The caller's aria-describedby, with the error text's id added when there is an error. */
function describedBy(callerValue: string | undefined, errorId: string | undefined): string | undefined {
  const ids = [callerValue, errorId].filter((value) => value !== undefined && value !== "")
  return ids.length > 0 ? ids.join(" ") : undefined
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, ...props }, ref) => {
    // useId, not a slug of the label: two inputs labelled the same would share an id.
    const generatedId = React.useId()
    const inputId = id ?? generatedId
    const errorId = error ? `${inputId}-error` : undefined
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-describedby={describedBy(ariaDescribedBy, errorId)}
          aria-invalid={ariaInvalid ?? (error ? true : undefined)}
          className={clsx(
            "h-10 rounded-lg border px-3 text-sm transition-colors",
            "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500",
            "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500",
            "focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500",
            error && "border-red-500 focus:border-red-500 focus:ring-red-500",
            className,
          )}
          {...props}
        />
        {error && <p id={errorId} className="text-sm text-red-500">{error}</p>}
      </div>
    )
  },
)
Input.displayName = "Input"
