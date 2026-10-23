import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { slugifyInput } from "../lib/slugify.js"
import { readScalarFromRecord } from "./read-record-scalar.js"
import { stringOption } from "./field-options.js"
import { Input } from "../components/ui.js"
import { CharCount, RefillButton } from "./field-parts.js"
import { useDerivedField } from "./use-derived-field.js"

/** A slug, made from another field (the title by default) until the editor types their own. */
export function SlugWidget(props: WidgetProps): React.ReactElement {
  const { config, value, readOnly, record, currentLocale, defaultLocale } = props
  const fromField = stringOption(config, "from") ?? "title"
  const strValue = value === null || value === undefined ? "" : String(value)
  const maxLength = config.validation?.maxLength
  const slug = useDerivedField(slugifyInput(readScalarFromRecord(record, fromField, currentLocale, defaultLocale)), props)

  return (
    <div>
      <div className="flex w-full items-center gap-2">
        <Input
          id={`field-${config.name}`}
          type="text"
          className="min-w-0 flex-1"
          value={strValue}
          onChange={(e) => { slug.type(e.target.value) }}
          readOnly={readOnly}
          required={config.required}
          maxLength={maxLength}
          autoComplete="off"
        />
        {!readOnly ? <RefillButton label={`Regenerate slug from ${fromField}`} onRefill={slug.refill} /> : null}
      </div>
      {maxLength ? <CharCount length={strValue.length} max={maxLength} /> : null}
    </div>
  )
}
