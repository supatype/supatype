import React from "react"
import { clsx } from "clsx"

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg"
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ padding = "md", className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          "rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900",
          {
            "p-4": padding === "sm",
            "p-6": padding === "md",
            "p-8": padding === "lg",
          },
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)
Card.displayName = "Card"
