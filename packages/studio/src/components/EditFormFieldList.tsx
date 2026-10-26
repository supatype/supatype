import React from "react"
import type { FieldConfig } from "../config.js"
import { getLocalizedFieldValue, getLocalizedFieldPlaceholder } from "../lib/edit-field-layout.js"
import { setLocalizedFieldValue } from "../lib/localized-field.js"
import { FieldWidget } from "../widgets/FieldWidget.js"

export interface EditFormFieldListProps {
  fields: FieldConfig[]
  values: Record<string, unknown>
  onChange: (fieldName: string, value: unknown) => void
  primaryKey: string
  currentLocale: string
  defaultLocale: string
  recordSyncKey: string
  slugFollowSource: boolean
  variant?: "default" | "meta"
  /** Per-field messages from the last refused save, keyed by column. */
  fieldErrors?: Record<string, string>
}

export function EditFormFieldList({
  fields,
  values,
  onChange,
  primaryKey,
  currentLocale,
  defaultLocale,
  recordSyncKey,
  slugFollowSource,
  variant = "default",
  fieldErrors,
}: EditFormFieldListProps): React.ReactElement {
  return (
    <>
      {fields.map((fieldConfig) => (
        <FieldWidget
          key={`${fieldConfig.name}-${currentLocale}-${variant}`}
          config={fieldConfig}
          {...(fieldErrors?.[fieldConfig.name] !== undefined && {
            error: fieldErrors[fieldConfig.name],
          })}
          value={getLocalizedFieldValue(values, fieldConfig, currentLocale, defaultLocale)}
          localePlaceholder={getLocalizedFieldPlaceholder(
            values,
            fieldConfig,
            currentLocale,
            defaultLocale,
          )}
          onChange={(val) => {
            onChange(
              fieldConfig.name,
              setLocalizedFieldValue(values[fieldConfig.name], fieldConfig.localized, currentLocale, val),
            )
          }}
          readOnly={
            variant === "meta" ||
            fieldConfig.readOnly === true ||
            fieldConfig.name === primaryKey
          }
          record={values}
          currentLocale={currentLocale}
          defaultLocale={defaultLocale}
          recordSyncKey={recordSyncKey}
          slugFollowSource={slugFollowSource}
          variant={variant}
        />
      ))}
    </>
  )
}
