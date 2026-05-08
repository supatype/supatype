import React, { useEffect, useLayoutEffect, useRef } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { slugifyInput } from "../lib/slugify.js"
import { readScalarFromRecord } from "./read-record-scalar.js"

export function SlugWidget({
  config,
  value,
  onChange,
  readOnly,
  record,
  currentLocale,
  defaultLocale,
  recordSyncKey,
  slugFollowSource = false,
}: WidgetProps): React.ReactElement {
  const fromField = (config.options?.["from"] as string | undefined) ?? "title"
  const strValue = value === null || value === undefined ? "" : String(value)
  const maxLength = config.validation?.["maxLength"] as number | undefined

  /** User edited the slug input; while true, live title→slug sync is paused (create only). */
  const manualRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const derived = slugifyInput(readScalarFromRecord(record, fromField, currentLocale, defaultLocale))

  useLayoutEffect(() => {
    manualRef.current = false
  }, [recordSyncKey])

  useEffect(() => {
    // `readOnly` only locks the DOM input; title→slug still updates draft state on create.
    if (!slugFollowSource) return
    if (manualRef.current) return
    if (derived === strValue) return
    onChangeRef.current(derived === "" ? null : derived)
  }, [derived, slugFollowSource, strValue])

  const regenerateLabel = `Regenerate slug from ${fromField}`

  return (
    <div className="st-widget-text st-widget-slug">
      <div className="st-widget-slug-row">
        <input
          id={`field-${config.name}`}
          type="text"
          className="st-input st-widget-slug-input"
          value={strValue}
          onChange={(e) => {
            manualRef.current = true
            onChange(e.target.value === "" ? null : e.target.value)
          }}
          readOnly={readOnly}
          required={config.required}
          maxLength={maxLength}
          autoComplete="off"
        />
        {!readOnly ? (
          <button
            type="button"
            className="st-btn-icon st-slug-refresh"
            aria-label={regenerateLabel}
            title={regenerateLabel}
            onClick={() => {
              manualRef.current = false
              const next = slugifyInput(
                readScalarFromRecord(record, fromField, currentLocale, defaultLocale),
              )
              onChange(next === "" ? null : next)
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>
        ) : null}
      </div>
      {maxLength ? (
        <span className="st-char-count">
          {strValue.length} / {maxLength}
        </span>
      ) : null}
    </div>
  )
}
