import React from "react"
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js"
import { isUuid, shortUuid } from "../lib/uuid.js"
import { IconCheck, IconCopy } from "./icons.js"
import { Button } from "./ui.js"

/** Where a UUID cell's text goes when it names another record: a label for the hover, and the jump. */
export interface UuidLink {
  title: string
  open: () => void
}

/**
 * A UUID in a table cell: its last five characters (`…3f9a2`), the whole value on hover, and a
 * button that copies the whole value.
 *
 * Every table that can show a UUID renders it through this, so a list, the data browser and a
 * query's results read the same. A value that is not a UUID renders as it is, which lets a column
 * that only sometimes holds one use it unconditionally. Forms and detail views show the full value
 * instead: there the id is the subject, not one column among many.
 *
 * `link` makes the text a button that opens the record the id names, as a foreign key does; a
 * key that is not a UUID still links, showing its whole value.
 */
export function UuidCell({ value, link }: { value: string; link?: UuidLink }): React.ReactElement {
  if (!isUuid(value)) return link ? <LinkText text={value} title={link.title} open={link.open} /> : <>{value}</>
  const text = shortUuid(value)
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono">
      {link ? <LinkText text={text} title={`${link.title}: ${value}`} open={link.open} /> : <span title={value}>{text}</span>}
      <CopyId id={value} />
    </span>
  )
}

/** The id as a link to the record it names, in the cell's own type size. */
function LinkText({ text, title, open }: { text: string; title: string; open: () => void }): React.ReactElement {
  return (
    <Button type="button" size="xs" variant="ghost" className="p-0 font-mono font-normal text-[length:inherit] text-primary hover:bg-transparent hover:text-primary hover:underline" onClick={open} title={title}>
      {text}
    </Button>
  )
}

/** Stops a click reaching the row behind it, which may open the record or start an edit. */
function keepToSelf(e: React.SyntheticEvent): void {
  e.stopPropagation()
}

function CopyId({ id }: { id: string }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard()
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-5 w-5"
        aria-label={`Copy ${id}`}
        title={`Copy ${id}`}
        onClick={(e) => { keepToSelf(e); copy(id) }}
        onDoubleClick={keepToSelf}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </Button>
      {copied ? <span role="status" className="text-[0.7rem] text-green-400">Copied</span> : null}
    </>
  )
}
