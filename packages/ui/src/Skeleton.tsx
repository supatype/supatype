import React from "react"
import { clsx } from "clsx"

export const Skeleton: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => {
  return (
    <div
      className={clsx("animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-800", className)}
      {...props}
    />
  )
}
