import React from "react"
import { IconButton } from "../components/ui.js"
import { IconRefresh } from "../components/icons.js"

/**
 * The small print the field editors share: how much of a length limit is used, a line explaining
 * what a value means, and why a value was refused. One look for each, rather than a class per
 * widget that each restyled the same line.
 */

/** "12 / 80": how much of a field's length limit the value uses, under the field at its right. */
export function CharCount({ length, max }: { length: number; max: number }): React.ReactElement {
  return (
    <span className="mt-1 block text-right text-[0.7rem] text-muted-foreground">
      {length} / {max}
    </span>
  )
}

/** A line under a field saying what its value means. */
export function FieldHint({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="mt-1 text-xs text-muted-foreground">{children}</p>
}

/** Why a field's value was refused, under it, announced as it appears. `id` is what the input names. */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <p className="mt-1 text-xs text-destructive-text" role="alert" {...(id !== undefined && { id })}>
      {children}
    </p>
  )
}

/** The button beside a derived field that refills it from its sources, named for what it reads. */
export function RefillButton({ label, onRefill }: { label: string; onRefill: () => void }): React.ReactElement {
  return (
    <IconButton label={label} onClick={onRefill}>
      <IconRefresh size={18} />
    </IconButton>
  )
}
