import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input } from "../components/ui.js"
import { durationMsOf, formatDuration, parseDuration } from "../lib/duration.js"
import { useFieldDraft } from "./use-field-draft.js"
import { FieldError } from "./field-parts.js"

/**
 * Editor for a `Duration` field, stored as `{ ms }`: one text box that reads `1h 30m`, `90m`,
 * `1:30:00` or `45s`, and shows the stored value back as `1h 30m`. The rules for what it accepts
 * live with the parser in `lib/duration.ts`.
 *
 * Text it cannot read is handed to the form as typed, not dropped, so the save check refuses it
 * instead of the previous value being saved as if the edit had worked.
 */

/** The text a stored value shows as. A value of the wrong shape is shown raw rather than hidden. */
function textOf(value: unknown): string {
  const ms = durationMsOf(value)
  if (ms !== null) return formatDuration(ms)
  if (value === null || value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** The form value for some typed text: `{ ms }`, null when blank, or the text itself when unreadable. */
function valueOf(text: string): unknown {
  const parsed = parseDuration(text)
  if (!parsed.ok) return text
  return parsed.ms === null ? null : { ms: parsed.ms }
}

export function DurationWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const { draft, setDraft, update } = useFieldDraft(value, onChange, textOf)
  const parsed = parseDuration(draft)
  const problem = parsed.ok ? null : parsed.message
  const errorId = `field-${config.name}-duration-error`

  return (
    <div className="flex flex-col">
      <Input
        id={`field-${config.name}`}
        value={draft}
        placeholder="e.g. 1h 30m, 90m or 1:30:00"
        readOnly={readOnly}
        required={config.required}
        aria-invalid={problem !== null}
        {...(problem !== null && { "aria-describedby": errorId })}
        onChange={(e) => update(e.target.value, valueOf(e.target.value))}
        // Once the editor leaves the box, show what was understood: `90m` becomes `1h 30m`.
        onBlur={() => { if (parsed.ok && parsed.ms !== null) setDraft(formatDuration(parsed.ms)) }}
      />
      {problem !== null && <FieldError id={errorId}>{problem}</FieldError>}
    </div>
  )
}
