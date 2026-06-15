import React from "react"
import type { FieldConfig } from "../config.js"
import { EditFormFieldList } from "./EditFormFieldList.js"
import { EditFormSidebar } from "./EditFormSidebar.js"

export interface EditFormLayoutProps {
  mainFields: FieldConfig[]
  metaFields: FieldConfig[]
  values: Record<string, unknown>
  onChange: (fieldName: string, value: unknown) => void
  primaryKey: string
  currentLocale: string
  defaultLocale: string
  recordSyncKey: string
  slugFollowSource: boolean
  saving: boolean
  onSave: () => void
  isCreate?: boolean
  onDuplicate?: () => void
  onDelete?: () => void
  preview?: React.ReactNode
  className?: string
}

export function EditFormLayout({
  mainFields,
  metaFields,
  values,
  onChange,
  primaryKey,
  currentLocale,
  defaultLocale,
  recordSyncKey,
  slugFollowSource,
  saving,
  onSave,
  isCreate,
  onDuplicate,
  onDelete,
  preview,
  className,
}: EditFormLayoutProps): React.ReactElement {
  const showSidebar = true

  return (
    <div className={["st-edit-layout", className].filter(Boolean).join(" ")}>
      <div className="st-edit-main">
        <form
          className="st-edit-form"
          onSubmit={(e) => {
            e.preventDefault()
            onSave()
          }}
        >
          <EditFormFieldList
            fields={mainFields}
            values={values}
            onChange={onChange}
            primaryKey={primaryKey}
            currentLocale={currentLocale}
            defaultLocale={defaultLocale}
            recordSyncKey={recordSyncKey}
            slugFollowSource={slugFollowSource}
          />
        </form>
        {preview}
      </div>
      {showSidebar && (
        <EditFormSidebar
          metaFields={metaFields}
          values={values}
          onChange={onChange}
          primaryKey={primaryKey}
          currentLocale={currentLocale}
          defaultLocale={defaultLocale}
          recordSyncKey={recordSyncKey}
          saving={saving}
          onSave={onSave}
          {...(isCreate !== undefined && { isCreate })}
          {...(onDuplicate !== undefined && { onDuplicate })}
          {...(onDelete !== undefined && { onDelete })}
        />
      )}
    </div>
  )
}
