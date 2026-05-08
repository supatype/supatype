import React, { useEffect, useLayoutEffect, useRef } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { readScalarFromRecord } from "./read-record-scalar.js"
import { applyComputedTemplate, fieldNamesInComputedTemplate } from "./preview-template.js"

function isSerializedEditorRoot(v: unknown): v is { root: { children?: unknown[] } } {
  if (typeof v !== "object" || v === null) return false
  const obj = v as Record<string, unknown>
  const root = obj.root
  if (typeof root !== "object" || root === null) return false
  return true
}

function collectLexicalText(node: unknown): string {
  if (typeof node !== "object" || node === null) return ""
  const n = node as Record<string, unknown>
  let out = typeof n.text === "string" ? n.text : ""
  const kids = n.children
  if (Array.isArray(kids)) {
    for (const c of kids) out += collectLexicalText(c)
  }
  return out
}

function previewFromDraftField(
  record: Record<string, unknown> | undefined,
  field: string,
  currentLocale?: string,
  defaultLocale?: string,
): string {
  const raw = record?.[field]
  if (raw === null || raw === undefined) return ""
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint") return String(raw)
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString()
  if (typeof raw === "object" && !Array.isArray(raw)) {
    // Lexical `SerializedEditorState` is `{ root: … }`, not `{ [locale]: … }` — detect before locale map.
    if (isSerializedEditorRoot(raw)) return collectLexicalText(raw.root).trim()
    if (currentLocale && defaultLocale) {
      const picked = (raw as Record<string, unknown>)[currentLocale]
        ?? (raw as Record<string, unknown>)[defaultLocale]
      if (typeof picked === "string" || typeof picked === "number") return String(picked)
      if (isSerializedEditorRoot(picked)) return collectLexicalText(picked.root).trim()
    }
  }
  return ""
}

function truncatePreview(joined: string, maxLen: number): string {
  const trimmed = joined.replace(/\s+/g, " ").trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…"
}

export function DerivedTextWidget({
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
  const template = typeof config.options?.["template"] === "string" ? config.options["template"] : undefined
  const rawSources = config.options?.["sources"]
  const sourcesList = Array.isArray(rawSources) ? (rawSources as string[]) : []
  const multiline = config.options?.["multiline"] === true

  const sourceLabel = template
    ? fieldNamesInComputedTemplate(template).join(", ").trim() || "template"
    : sourcesList.length > 0
      ? sourcesList.join(", ")
      : "title"

  const strValue = value === null || value === undefined ? "" : String(value)
  const rawMaxLength = config.validation?.["maxLength"]
  const parsedMax =
    typeof rawMaxLength === "number"
      ? rawMaxLength
      : typeof rawMaxLength === "string"
        ? Number.parseInt(rawMaxLength, 10)
        : NaN
  const previewCap = Number.isFinite(parsedMax) ? parsedMax : multiline ? 2000 : 280

  const manualRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const derivePreview = (): string => {
    const getFieldText = (field: string): string => {
      const v =
        previewFromDraftField(record, field, currentLocale, defaultLocale)
        || readScalarFromRecord(record, field, currentLocale, defaultLocale)
      return String(v ?? "").trim()
    }
    if (template) return applyComputedTemplate(template, getFieldText)
    const concatFields = sourcesList.length > 0 ? sourcesList : ["title"]
    const joined = concatFields
      .map(getFieldText)
      .filter((t) => t.length > 0)
      .join(" ")
    return truncatePreview(joined, previewCap)
  }

  const derived = derivePreview()

  useLayoutEffect(() => {
    manualRef.current = false
  }, [recordSyncKey])

  useEffect(() => {
    // `readOnly` only locks the DOM input; keep syncing derived preview into form state on create so saves include it.
    if (!slugFollowSource) return
    if (manualRef.current) return
    if (derived === strValue) return
    onChangeRef.current(derived === "" ? null : derived)
  }, [derived, slugFollowSource, strValue])

  const regenerateLabel = `Refill preview from ${sourceLabel}`

  const countMax = Number.isFinite(parsedMax) ? parsedMax : undefined
  const fieldId = `field-${config.name}`

  return (
    <div className="st-widget-text st-widget-derived-text">
      <div className="st-widget-slug-row">
        {multiline ? (
          <textarea
            id={fieldId}
            className="st-input st-widget-derived-text-multiline"
            rows={5}
            value={strValue}
            readOnly={readOnly}
            required={config.required}
            onChange={(e) => {
              manualRef.current = true
              onChange(e.target.value === "" ? null : e.target.value)
            }}
            maxLength={countMax}
          />
        ) : (
          <input
            id={fieldId}
            type="text"
            className="st-input st-widget-slug-input"
            value={strValue}
            readOnly={readOnly}
            required={config.required}
            onChange={(e) => {
              manualRef.current = true
              onChange(e.target.value === "" ? null : e.target.value)
            }}
            autoComplete="off"
            maxLength={countMax}
          />
        )}
        {!readOnly ? (
          <button
            type="button"
            className="st-btn-icon st-slug-refresh"
            aria-label={regenerateLabel}
            title={regenerateLabel}
            onClick={() => {
              manualRef.current = false
              const next = derivePreview()
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
      {countMax !== undefined ? (
        <span className="st-char-count">
          {strValue.length} / {countMax}
        </span>
      ) : null}
    </div>
  )
}
