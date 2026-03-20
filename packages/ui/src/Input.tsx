import React from "react"
import { clsx } from "clsx"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-")
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
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    )
  },
)
Input.displayName = "Input"
