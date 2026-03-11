import React, { useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"

const STATUSES = ["draft", "published", "scheduled", "archived"] as const
type PublishStatus = typeof STATUSES[number]

const STATUS_TRANSITIONS: Record<PublishStatus, PublishStatus[]> = {
  draft: ["published", "scheduled"],
  published: ["archived", "draft"],
  scheduled: ["draft", "published"],
  archived: ["draft"],
}

export function PublishWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const currentStatus = (typeof value === "string" && STATUSES.includes(value as PublishStatus))
    ? value as PublishStatus
    : "draft"

  const allowedTransitions = STATUS_TRANSITIONS[currentStatus] ?? []

  return (
    <div className="st-publish-widget">
      <div className="st-publish-current">
        <span className={`st-publish-badge st-publish-badge--${currentStatus}`}>
          {currentStatus}
        </span>
      </div>

      {!readOnly && (
        <div className="st-publish-actions">
          {allowedTransitions.map((status) => (
            <button
              key={status}
              type="button"
              className={`st-btn st-btn-sm st-publish-btn--${status}`}
              onClick={() => { onChange(status) }}
            >
              {statusAction(currentStatus, status)}
            </button>
          ))}

          {currentStatus === "draft" && (
            <ScheduleInput
              onSchedule={(date) => {
                onChange("scheduled")
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ScheduleInput({ onSchedule }: { onSchedule: (date: string) => void }): React.ReactElement {
  const [showPicker, setShowPicker] = useState(false)
  const [date, setDate] = useState("")

  if (!showPicker) {
    return (
      <button
        type="button"
        className="st-btn st-btn-sm"
        onClick={() => { setShowPicker(true) }}
      >
        Schedule...
      </button>
    )
  }

  return (
    <div className="st-schedule-picker">
      <input
        type="datetime-local"
        className="st-input st-input-sm"
        value={date}
        onChange={(e) => { setDate(e.target.value) }}
        min={new Date().toISOString().slice(0, 16)}
      />
      <button
        type="button"
        className="st-btn st-btn-sm st-btn-primary"
        onClick={() => {
          if (date) onSchedule(new Date(date).toISOString())
        }}
        disabled={!date}
      >
        Confirm
      </button>
    </div>
  )
}

function statusAction(from: PublishStatus, to: PublishStatus): string {
  if (to === "published") return "Publish"
  if (to === "draft") return "Unpublish"
  if (to === "archived") return "Archive"
  if (to === "scheduled") return "Schedule"
  return to
}
