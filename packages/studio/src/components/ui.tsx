import React from "react"
import { cn } from "../lib/utils.js"

/* ─── Nav rail ─── */

/**
 * The horizontal rail the secondary panel's header and the tertiary nav each occupy.
 *
 * They start at the same y and sit side by side, so their bottom borders read as one line running
 * the width of the app. They were built separately and did not match: the nav was exactly 40px
 * (`h-10`) while the panel header was padding-derived (`pt-4 pb-2.5`, about 42px), and the two
 * borders were drawn at different opacities. The line stepped down and changed colour at the panel
 * edge.
 *
 * One constant rather than the same classes written twice, because the bug is drift: either height
 * can be adjusted alone and look correct in isolation.
 */
export const NAV_RAIL = "h-10 shrink-0 border-b border-border/80"

/* ─── Badge / Pill ─── */

export type BadgeVariant = "green" | "red" | "yellow" | "indigo" | "blue" | "outline"

const badgeColors: Record<BadgeVariant, string> = {
  green: "bg-green-500/15 text-green-400",
  red: "bg-red-500/15 text-red-400",
  yellow: "bg-yellow-500/15 text-yellow-400",
  indigo: "bg-indigo-500/15 text-indigo-400",
  blue: "bg-blue-500/15 text-blue-400",
  // No colour of its own: an outline badge is for callers that supply their own border and
  // text colour. It replaced a second Badge component that existed only for this one use.
  outline: "border border-border bg-transparent text-foreground",
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
type ButtonSize = "sm" | "md" | "xs" | "icon"

const buttonVariants: Record<ButtonVariant, string> = {
  secondary: "border border-border bg-secondary text-foreground hover:bg-accent",
  primary: "border bg-primary text-primary-foreground border-primary hover:opacity-90",
  destructive: "border bg-destructive text-destructive-foreground border-destructive hover:opacity-90",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-accent",
}

const buttonSizes: Record<ButtonSize, string> = {
  // Square, for a button whose whole label is its glyph. The text sizes carry horizontal padding
  // meant for words, which around an icon reads as a gap rather than as a target. Sized to match
  // the icon buttons already in the top bar, and given a floor so a 12px glyph still has something
  // to hit.
  //
  // Note there is a second, unrelated `Button` in ./ui/button.tsx, which is what the package
  // exports publicly, and its `size="icon"` is a 40px square. The two components already disagree
  // about `sm`, `ghost` and `secondary`; this is one more name they share and do not agree on.
  icon: "h-7 w-7 justify-center shrink-0",
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
      className={cn("inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none", buttonSizes[size], buttonVariants[variant], className)}
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
      // A disabled input has to *look* disabled. Without these it renders identically to an
      // editable one, so a field the form will never read looks like a field you forgot to
      // fill in, and clicking it does nothing with no explanation.
      className={cn("w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:bg-muted disabled:text-muted-foreground disabled:border-border/60 disabled:cursor-not-allowed disabled:focus:ring-0 disabled:focus:border-border/60", className)}
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
