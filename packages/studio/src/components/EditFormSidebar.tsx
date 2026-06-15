import React from "react"
import type { FieldConfig } from "../config.js"
import { EditFormFieldList } from "./EditFormFieldList.js"

export interface EditFormSidebarProps {
  metaFields: FieldConfig[]
  values: Record<string, unknown>
  onChange: (fieldName: string, value: unknown) => void
  primaryKey: string
  currentLocale: string
  defaultLocale: string
  recordSyncKey: string
  saving: boolean
  onSave: () => void
  isCreate?: boolean
  onDuplicate?: () => void
  onDelete?: () => void
}

export function EditFormSidebar({
  metaFields,
  values,
  onChange,
  primaryKey,
  currentLocale,
  defaultLocale,
  recordSyncKey,
  saving,
  onSave,
  isCreate = false,
  onDuplicate,
  onDelete,
}: EditFormSidebarProps): React.ReactElement {
  return (
    <aside className="st-edit-sidebar" aria-label="Record metadata">
      {metaFields.length > 0 && (
        <div className="st-edit-sidebar-section">
          <h3 className="st-edit-sidebar-title">Record info</h3>
          <EditFormFieldList
            fields={metaFields}
            values={values}
            onChange={onChange}
            primaryKey={primaryKey}
            currentLocale={currentLocale}
            defaultLocale={defaultLocale}
            recordSyncKey={recordSyncKey}
            slugFollowSource={false}
            variant="meta"
          />
        </div>
      )}

      <div className="st-edit-sidebar-actions">
        <button
          type="button"
          className="st-btn st-btn-primary st-edit-sidebar-save"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {!isCreate && onDuplicate && (
          <button type="button" className="st-btn" onClick={onDuplicate}>
            Duplicate
          </button>
        )}
        {!isCreate && onDelete && (
          <button type="button" className="st-btn st-btn-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </aside>
  )
}
