import React from "react"
import { clsx } from "clsx"

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "danger" | "purple"
}

export const Badge: React.FC<BadgeProps> = ({ variant = "default", className, children, ...props }) => {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        {
          "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300": variant === "default",
          "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300": variant === "success",
          "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300": variant === "warning",
          "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300": variant === "danger",
          "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300": variant === "purple",
        },
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
