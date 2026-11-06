import React from "react"
import { clsx } from "clsx"
import { FIELD_ERROR, FIELD_FRAME, FieldLayout, useField } from "./field.js"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, ...props }, ref) => {
    const field = useField(props, { label, error })
    return (
      <FieldLayout field={field}>
        <input
          ref={ref}
          {...props}
          {...field.control}
          className={clsx("h-10 px-3", FIELD_FRAME, error && FIELD_ERROR, className)}
        />
      </FieldLayout>
    )
  },
)
Input.displayName = "Input"
