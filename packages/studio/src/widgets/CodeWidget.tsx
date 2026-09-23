import React from "react"
import { json as jsonLang } from "@codemirror/lang-json"
import { sql as sqlLang } from "@codemirror/lang-sql"
import { xml as xmlLang } from "@codemirror/lang-xml"
import type { Extension } from "@codemirror/state"
import type { WidgetProps } from "./FieldWidget.js"
import { CodeMirrorEditor } from "./CodeMirrorEditor.js"

/**
 * Editor for a `Code<Lang>` field, `{ lang, source }` stored as JSONB.
 *
 * The value is an object, not a string, so this edits `source` and leaves `lang` as the schema
 * declared it. Without this widget the field falls to the raw JSON editor, where a snippet is a
 * single escaped line and every newline is a literal `\n`.
 */
const highlighters: Record<string, Extension[]> = {
  sql: [sqlLang()],
  json: [jsonLang()],
  xml: [xmlLang()],
  html: [xmlLang()],
}

interface CodeValue {
  lang?: string
  source?: string
}

function asCodeValue(value: unknown): CodeValue {
  return typeof value === "object" && value !== null ? (value as CodeValue) : {}
}

export function CodeWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const current = asCodeValue(value)
  const lang = typeof current.lang === "string" ? current.lang : ""
  const source = typeof current.source === "string" ? current.source : ""

  // Plain text for a language with no highlighter, rather than pretending one applied.
  const extensions = highlighters[lang.toLowerCase()] ?? []

  return (
    <div className="st-code-widget">
      <div className="st-json-editor rounded-md border border-border bg-background overflow-hidden">
        <CodeMirrorEditor
          id={`field-${config.name}`}
          value={source}
          onChange={(next) => {
            // `lang` is carried through unchanged: it comes from the schema, and dropping it here
            // would rewrite the row's shape on every keystroke.
            onChange?.({ ...current, source: next } as never)
          }}
          readOnly={readOnly}
          extensions={extensions}
          minHeight="180px"
        />
      </div>
      {lang !== "" && (
        <p className="st-field-hint text-xs text-muted-foreground mt-1">
          {lang}
          {extensions.length === 0 && ", no highlighter for this language"}
        </p>
      )}
    </div>
  )
}
