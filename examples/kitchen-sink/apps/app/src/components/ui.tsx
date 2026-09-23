import React, { useState } from "react"

/**
 * The example's own primitives.
 *
 * Five screens used to hand-roll their markup against a stylesheet that had grown a class per
 * view, so each one had its own idea of a card, its own type scale, and its own spacing. Anything
 * a screen needs twice belongs here instead, which is also the pattern the example is meant to
 * demonstrate to whoever copies it.
 *
 * Deliberately plain React and CSS: no design-system dependency, because an example that needs one
 * installed before it renders is teaching the wrong lesson.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}

/* ── Layout ────────────────────────────────────────────────────────────────── */

export function Stack({
  gap = 12,
  className,
  children,
}: {
  gap?: number
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={cx("ks-stack", className)} style={{ gap }}>
      {children}
    </div>
  )
}

export function Row({
  gap = 8,
  wrap = false,
  align = "center",
  className,
  children,
}: {
  gap?: number
  wrap?: boolean
  align?: "center" | "top"
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      className={cx("ks-row", wrap && "ks-row--wrap", align === "top" && "ks-row--top", className)}
      style={{ gap }}
    >
      {children}
    </div>
  )
}

export function Grid({
  columns = 2,
  children,
}: {
  columns?: 2 | 3
  children: React.ReactNode
}): React.ReactElement {
  return <div className={cx("ks-grid", `ks-grid--${columns}`)}>{children}</div>
}

/* ── Page header ───────────────────────────────────────────────────────────── */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <header className="ks-page">
      <div className="ks-page__text">
        <h1>{title}</h1>
        {subtitle !== undefined && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

/**
 * What this screen demonstrates, folded away by default.
 *
 * The explanation used to sit in the app's chrome as `Proves: useQuery, relations, ordering`,
 * directly under the navigation, which made a conference app read as a test harness. It is still
 * worth having — reading the example is the point — so it stays, one click away, where it does not
 * dress the product up as a fixture.
 */
export function ProvesNote({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="ks-proves">
      <button
        type="button"
        className="ks-proves__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "What this demonstrates"}
      </button>
      {open && <div className="ks-proves__body ks-prose">{children}</div>}
    </div>
  )
}

/* ── Card ──────────────────────────────────────────────────────────────────── */

export function Card({
  title,
  action,
  padded = true,
  flat = false,
  className,
  children,
}: {
  title?: string
  action?: React.ReactNode
  padded?: boolean
  flat?: boolean
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className={cx("ks-card", flat && "ks-card--flat", className)}>
      {title !== undefined && (
        <header className="ks-card__head">
          <h2>{title}</h2>
          {action !== undefined && (
            <>
              <span className="ks-spacer" />
              {action}
            </>
          )}
        </header>
      )}
      {padded ? <div className="ks-card__pad">{children}</div> : children}
    </section>
  )
}

/* ── Badge ─────────────────────────────────────────────────────────────────── */

export type BadgeTone = "neutral" | "accent" | "error" | "warn"

export function Badge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: BadgeTone
  dot?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className={cx("ks-badge", `ks-badge--${tone}`)}>
      {dot && <span className="ks-badge__dot" />}
      {children}
    </span>
  )
}

/* ── Button ────────────────────────────────────────────────────────────────── */

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: {
  variant?: "primary" | "secondary" | "ghost"
  size?: "sm" | "md"
  className?: string
  children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">): React.ReactElement {
  return (
    <button
      className={cx(
        "ks-btn",
        variant === "primary" && "ks-btn--primary",
        variant === "ghost" && "ks-btn--ghost",
        size === "sm" && "ks-btn--sm",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ── Field ─────────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="ks-field">
      <label className="ks-field__label">{label}</label>
      {children}
      {error != null && error !== "" ? (
        <span className="ks-field__hint" style={{ color: "var(--ks-error)" }}>
          {error}
        </span>
      ) : (
        hint !== undefined && <span className="ks-field__hint">{hint}</span>
      )}
    </div>
  )
}

export function Input({
  invalid = false,
  className,
  ...rest
}: {
  invalid?: boolean
  className?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">): React.ReactElement {
  return <input className={cx("ks-input", invalid && "ks-input--invalid", className)} {...rest} />
}

/* ── Avatar ────────────────────────────────────────────────────────────────── */

export function Avatar({
  name,
  src,
  size = 36,
}: {
  name: string
  src?: string | null
  size?: number
}): React.ReactElement {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
  return (
    <span
      className="ks-avatar"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}
      aria-hidden="true"
    >
      {src != null && src !== "" ? <img src={src} alt="" /> : initials || "?"}
    </span>
  )
}

/* ── Status ────────────────────────────────────────────────────────────────── */

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="ks-empty">
      <h3>{title}</h3>
      {children !== undefined && <p>{children}</p>}
      {action !== undefined && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "warn"
  children: React.ReactNode
}): React.ReactElement {
  return <div className={cx("ks-note", `ks-note--${tone}`)} role={tone === "error" ? "alert" : undefined}>{children}</div>
}

/** Placeholder rows, so a slow query does not look like an empty one. */
export function Skeleton({ rows = 3, height = 64 }: { rows?: number; height?: number }): React.ReactElement {
  return (
    <Stack gap={10}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ks-skeleton" style={{ height }} />
      ))}
    </Stack>
  )
}
