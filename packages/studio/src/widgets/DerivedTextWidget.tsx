import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { readScalarFromRecord } from "./read-record-scalar.js"
import { applyComputedTemplate, fieldNamesInComputedTemplate } from "./preview-template.js"
import { isJsonObject, isString } from "../lib/json.js"
import { Input, Textarea } from "../components/ui.js"
import { CharCount, RefillButton } from "./field-parts.js"
import { useDerivedField } from "./use-derived-field.js"

function isSerializedEditorRoot(v: unknown): v is { root: object } {
  return isJsonObject(v) && typeof v.root === "object" && v.root !== null
}

function collectLexicalText(n: unknown): string {
  if (!isJsonObject(n)) return ""
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
  if (isJsonObject(raw)) {
    // Lexical `SerializedEditorState` is `{ root: … }`, not `{ [locale]: … }`, detect before locale map.
    if (isSerializedEditorRoot(raw)) return collectLexicalText(raw.root).trim()
    if (currentLocale && defaultLocale) {
      const picked = raw[currentLocale] ?? raw[defaultLocale]
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

/** What a derived text field is made from, read from its options. */
interface DerivedSettings {
  template: string | undefined
  sources: string[]
  multiline: boolean
  /** The fields it reads, named on the refill button. */
  sourceLabel: string
  /** The most characters the joined sources are cut to: the field's own limit, or a default. */
  previewCap: number
}

function derivedSettings(config: WidgetProps["config"]): DerivedSettings {
  const template = typeof config.options?.["template"] === "string" ? config.options["template"] : undefined
  const rawSources = config.options?.["sources"]
  const sources = Array.isArray(rawSources) ? rawSources.filter(isString) : []
  const multiline = config.options?.["multiline"] === true
  const sourceLabel = template
    ? fieldNamesInComputedTemplate(template).join(", ").trim() || "template"
    : sources.length > 0 ? sources.join(", ") : "title"
  return { template, sources, multiline, sourceLabel, previewCap: config.validation?.maxLength ?? (multiline ? 2000 : 280) }
}

/** The text the field's sources make: its template filled in, or its sources joined and cut to size. */
function derivedText(settings: DerivedSettings, from: Pick<WidgetProps, "record" | "currentLocale" | "defaultLocale">): string {
  const { record, currentLocale, defaultLocale } = from
  const getFieldText = (field: string): string => {
    const v =
      previewFromDraftField(record, field, currentLocale, defaultLocale)
      || readScalarFromRecord(record, field, currentLocale, defaultLocale)
    return String(v ?? "").trim()
  }
  if (settings.template) return applyComputedTemplate(settings.template, getFieldText)
  const joined = (settings.sources.length > 0 ? settings.sources : ["title"])
    .map(getFieldText)
    .filter((t) => t.length > 0)
    .join(" ")
  return truncatePreview(joined, settings.previewCap)
}

/** Text made from other fields (a summary, a preview line) until the editor types their own. */
export function DerivedTextWidget(props: WidgetProps): React.ReactElement {
  const { config, value, readOnly } = props
  const settings = derivedSettings(config)
  const field = useDerivedField(derivedText(settings, props), props)
  const strValue = value === null || value === undefined ? "" : String(value)
  const declaredMax = config.validation?.maxLength
  const typed = {
    id: `field-${config.name}`,
    value: strValue,
    readOnly,
    required: config.required,
    maxLength: declaredMax,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { field.type(e.target.value) },
  }

  return (
    <div>
      <div className="flex w-full items-center gap-2">
        {settings.multiline
          ? <Textarea face="prose" className="min-w-0 flex-1" rows={5} {...typed} />
          : <Input type="text" className="min-w-0 flex-1" autoComplete="off" {...typed} />}
        {!readOnly ? <RefillButton label={`Refill preview from ${settings.sourceLabel}`} onRefill={field.refill} /> : null}
      </div>
      {declaredMax !== undefined ? <CharCount length={strValue.length} max={declaredMax} /> : null}
    </div>
  )
}
