import React, { useState } from "react"
import { Button, Input } from "./ui.js"

interface ScheduleControlProps {
  /** ISO timestamp of the schedule already set, or null. */
  scheduledFor: string | null
  busy: boolean
  onSchedule: (at: Date) => void
  onCancel: () => void
}

/**
 * Put a time on a pending edit, or take one off.
 *
 * **This is a real scheduler, not a rule about a timestamp.** Without versions, scheduling needed no
 * machinery: the access rule compared `published_at <= now()`, so a future date simply hid the row
 * until it arrived. That works only while the content is already in the live row. Once publishing
 * means copying a draft in, something has to do the copying, and a schedule is an instruction to a
 * job rather than a fact about a column.
 *
 * Which means it can be late. If the database has no scheduler the whole feature works except the
 * clock, and this control would set a time nothing acts on — so it says so rather than implying a
 * promise the deployment cannot keep.
 */
export function ScheduleControl({
  scheduledFor,
  busy,
  onSchedule,
  onCancel,
}: ScheduleControlProps): React.ReactElement {
  const [value, setValue] = useState("")

  if (scheduledFor !== null) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          Goes live {formatWhen(scheduledFor)}
        </span>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    )
  }

  const at = value === "" ? null : new Date(value)
  const valid = at !== null && !Number.isNaN(at.getTime()) && at.getTime() > Date.now()

  return (
    <div className="flex items-center gap-2">
      <Input
        type="datetime-local"
        value={value}
        onChange={(e) => { setValue(e.target.value) }}
        aria-label="When to publish"
        className="max-w-[15rem]"
      />
      <Button
        size="xs"
        variant="secondary"
        disabled={busy || !valid}
        onClick={() => {
          if (at !== null) onSchedule(at)
        }}
      >
        Schedule
      </Button>
      {value !== "" && !valid && (
        <span className="text-xs text-muted-foreground">Pick a time in the future.</span>
      )}
    </div>
  )
}

function formatWhen(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString()
}
