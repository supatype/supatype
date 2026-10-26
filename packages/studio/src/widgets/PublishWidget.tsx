import React, { useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Badge, Button, Input, type BadgeVariant } from "../components/ui.js"

const STATUSES = ["draft", "published", "scheduled", "archived"] as const
type PublishStatus = typeof STATUSES[number]

const STATUS_TRANSITIONS: Record<PublishStatus, PublishStatus[]> = {
  draft: ["published", "scheduled"],
  published: ["archived", "draft"],
  scheduled: ["draft", "published"],
  archived: ["draft"],
}

const STATUS_BADGES: Record<PublishStatus, BadgeVariant> = {
  draft: "yellow",
  published: "green",
  scheduled: "blue",
  archived: "outline",
}

export function PublishWidget({ value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const currentStatus = STATUSES.find((status) => status === value) ?? "draft"
  const allowedTransitions = STATUS_TRANSITIONS[currentStatus] ?? []

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Badge variant={STATUS_BADGES[currentStatus]}>{currentStatus}</Badge>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap gap-1">
          {allowedTransitions.map((status) => (
            <Button key={status} type="button" size="xs" onClick={() => { onChange(status) }}>
              {statusAction(status)}
            </Button>
          ))}

          {currentStatus === "draft" && <ScheduleInput onSchedule={() => { onChange("scheduled") }} />}
        </div>
      )}
    </div>
  )
}

function ScheduleInput({ onSchedule }: { onSchedule: (date: string) => void }): React.ReactElement {
  const [showPicker, setShowPicker] = useState(false)
  const [date, setDate] = useState("")

  if (!showPicker) {
    return <Button type="button" size="xs" onClick={() => { setShowPicker(true) }}>Schedule...</Button>
  }

  return (
    <div className="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <Input type="datetime-local" aria-label="Publish at" className="px-2 py-1 text-xs" value={date} onChange={(e) => { setDate(e.target.value) }} min={new Date().toISOString().slice(0, 16)} />
      <Button type="button" size="xs" variant="primary" onClick={() => { if (date) onSchedule(new Date(date).toISOString()) }} disabled={!date}>
        Confirm
      </Button>
    </div>
  )
}

function statusAction(to: PublishStatus): string {
  if (to === "published") return "Publish"
  if (to === "draft") return "Unpublish"
  if (to === "archived") return "Archive"
  if (to === "scheduled") return "Schedule"
  return to
}
