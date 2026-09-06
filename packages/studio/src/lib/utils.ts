import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * A stored timestamp as a person reads it, or the raw value when it is not a date.
 *
 * Falls back rather than throwing or printing "Invalid Date": these render inside badges and
 * tooltips where an unparseable value is far more useful shown than swallowed.
 *
 * Four byte-identical copies of this had accumulated, in the schedule control, the share panel,
 * the publish bar and the version history. They are the same question.
 */
export function formatTimestamp(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString()
}
