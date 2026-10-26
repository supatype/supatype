import React from "react"

/**
 * A value a field access rule kept from the caller: the padlock, in place of the value.
 *
 * Shared so a list cell and an edit form say it the same way. `hidden` is certain: the rule withholds
 * this value. `unknown` is a list cell's honest answer to a per-row rule it cannot settle: the record
 * either withholds the value or has none, and nothing the list has can tell which.
 */
export function WithheldValue({ access }: { access: "hidden" | "unknown" }): React.ReactElement {
  if (access === "unknown") {
    return (
      <span
        className="st-cell-masked st-cell-masked-unknown"
        title="Hidden by a field access rule, or empty, this column is restricted per record"
        aria-label="Hidden by a field access rule, or empty"
      >
        &#128274;?
      </span>
    )
  }

  return (
    <span className="st-cell-masked" title="Hidden by a field access rule" aria-label="Hidden by a field access rule">
      &#128274;
    </span>
  )
}
