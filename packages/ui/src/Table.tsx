// Table parts that render the native table elements, so each keeps its implicit ARIA role
// (table, rowgroup, row, columnheader, cell). No data fetching, sorting or paging: compose them.
import React from "react"
import { clsx } from "clsx"

type TableTag = "table" | "thead" | "tbody" | "tr" | "th" | "td"

/** One table part: the native `tag` with the base classes, the caller's className and its ref. */
function tablePart<E extends HTMLElement, P extends React.HTMLAttributes<E>>(tag: TableTag, base: string, displayName: string) {
  const Part = React.forwardRef<E, P>(({ className, ...props }, ref) =>
    React.createElement(tag, { ...props, ref, className: clsx(base, className) }),
  )
  Part.displayName = displayName
  return Part
}

export type TableProps = React.TableHTMLAttributes<HTMLTableElement>
export type TableSectionProps = React.HTMLAttributes<HTMLTableSectionElement>
export type TrProps = React.HTMLAttributes<HTMLTableRowElement>
export type ThProps = React.ThHTMLAttributes<HTMLTableCellElement>
export type TdProps = React.TdHTMLAttributes<HTMLTableCellElement>

export const Table = tablePart<HTMLTableElement, TableProps>("table", "w-full text-sm", "Table")

export const THead = tablePart<HTMLTableSectionElement, TableSectionProps>(
  "thead",
  "border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-800/40",
  "THead",
)

export const TBody = tablePart<HTMLTableSectionElement, TableSectionProps>("tbody", "", "TBody")

export const Tr = tablePart<HTMLTableRowElement, TrProps>(
  "tr",
  "border-b border-neutral-200 last:border-0 dark:border-neutral-800",
  "Tr",
)

export const Th = tablePart<HTMLTableCellElement, ThProps>(
  "th",
  "whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400",
  "Th",
)

export const Td = tablePart<HTMLTableCellElement, TdProps>("td", "px-3 py-2 text-neutral-900 dark:text-neutral-100", "Td")
