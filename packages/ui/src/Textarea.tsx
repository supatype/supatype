import React from "react"
import { clsx } from "clsx"
import { FIELD_ERROR, FIELD_FRAME, FieldLayout, useField } from "./field.js"

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className, ...props }, ref) => {
    const field = useField(props, { label, error })
    return (
      <FieldLayout field={field}>
        <textarea
          ref={ref}
          {...props}
          {...field.control}
          className={clsx("min-h-20 px-3 py-2", FIELD_FRAME, error && FIELD_ERROR, className)}
        />
      </FieldLayout>
    )
  },
)
Textarea.displayName = "Textarea"
