import React from "react"
import { cn } from "../lib/utils.js"

/* ─── Badge / Pill ─── */

type BadgeVariant = "green" | "red" | "yellow" | "indigo" | "blue"

const badgeColors: Record<BadgeVariant, string> = {
  green: "bg-green-500/15 text-green-400",
  red: "bg-red-500/15 text-red-400",
  yellow: "bg-yellow-500/15 text-yellow-400",
  indigo: "bg-indigo-500/15 text-indigo-400",
  blue: "bg-blue-500/15 text-blue-400",
}

export function Badge({
  variant = "green",
  children,
  className,
  ...props
}: {
  variant?: BadgeVariant
  children: React.ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "className">): React.ReactElement {
  return (
    <span className={cn("inline-block px-1.5 py-0.5 rounded-full text-[11px] font-medium", badgeColors[variant], className)} {...props}>
      {children}
    </span>
  )
}

/* ─── Button ─── */

type ButtonVariant = "secondary" | "primary" | "destructive" | "ghost"
type ButtonSize = "sm" | "md" | "xs"

const buttonVariants: Record<ButtonVariant, string> = {
  secondary: "border border-border bg-secondary text-foreground hover:bg-accent",
  primary: "border bg-primary text-primary-foreground border-primary hover:opacity-90",
  destructive: "border bg-destructive text-destructive-foreground border-destructive hover:opacity-90",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-accent",
}

const buttonSizes: Record<ButtonSize, string> = {
  xs: "px-2 py-1 text-[0.7rem]",
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
}

export function Button({
  variant = "secondary",
  size = "sm",
  className,
  children,
  ...props
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">): React.ReactElement {
  return (
    <button
      className={cn("inline-flex items-center gap-1.5 rounded-md font-medium transition-colors", buttonSizes[size], buttonVariants[variant], className)}
      {...props}
    >
      {children}
    </button>
  )
}

/* ─── Card ─── */

export function Card({
  className,
  children,
  ...props
}: {
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div className={cn("rounded-lg border border-border bg-card", className)} {...props}>
      {children}
    </div>
  )
}

/* ─── Input ─── */

export function Input({
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className"> & { className?: string }): React.ReactElement {
  return (
    <input
      className={cn("w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20", className)}
      {...props}
    />
  )
}

/* ─── Select ─── */

export function Select({
  className,
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className"> & { className?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <select
      className={cn("px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20", className)}
      {...props}
    >
      {children}
    </select>
  )
}

/* ─── Table primitives ─── */

export function Th({
  className,
  children,
  ...props
}: {
  className?: string
  children?: React.ReactNode
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "className">): React.ReactElement {
  return (
    <th className={cn("text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider", className)} {...props}>
      {children}
    </th>
  )
}

export function Td({
  className,
  children,
  ...props
}: {
  className?: string
  children?: React.ReactNode
} & Omit<React.TdHTMLAttributes<HTMLTableCellElement>, "className">): React.ReactElement {
  return (
    <td className={cn("px-3 py-2 text-sm", className)} {...props}>
      {children}
    </td>
  )
}

/* ─── Code block ─── */

export function CodeBlock({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={cn("rounded-md border border-border bg-background p-4 font-mono text-sm overflow-x-auto whitespace-pre", className)}>
      {children}
    </div>
  )
}
