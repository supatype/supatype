import React from "react"
import type { FieldConfig } from "../config.js"
import { EditFormFieldList } from "./EditFormFieldList.js"
import { Button } from "./ui.js"

/** The sidebar's actions stack, each as wide as the sidebar. */
const FULL_WIDTH = "w-full justify-center"

export interface EditFormSidebarProps {
  /**
   * Publishing controls, when the view has them.
   *
   * A slot rather than a rendered section: what goes here supplies its own heading, so a model that
   * keeps no versions leaves no empty titled block behind. When given it holds the form's save too
   * ("Save draft", beside Publish), and the plain Save below is left out so there are not two.
   */
  publishing?: React.ReactNode
  /** Opens the preview slide-over, below the publishing status it previews the result of. */
  previewAction?: React.ReactNode
  metaFields: FieldConfig[]
  values: Record<string, unknown>
  onChange: (fieldName: string, value: unknown) => void
  primaryKey: string
  currentLocale: string
  defaultLocale: string
  recordSyncKey: string
  saving: boolean
  /** Saves the form; left out for a reader who may not change the record, so no Save is offered. */
  onSave?: () => void
  isCreate?: boolean
  onDuplicate?: () => void
  onDelete?: () => void
}

export function EditFormSidebar({
  publishing,
  previewAction,
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
      {publishing}
      {previewAction !== undefined && (
        <div className="st-edit-sidebar-section">{previewAction}</div>
      )}
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
        {publishing === undefined && onSave !== undefined && (
          <Button type="button" variant="primary" size="md" className={FULL_WIDTH} onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        )}
        {!isCreate && onDuplicate && (
          <Button type="button" size="md" className={FULL_WIDTH} onClick={onDuplicate}>
            Duplicate
          </Button>
        )}
        {!isCreate && onDelete && (
          <Button type="button" variant="destructive" size="md" className={FULL_WIDTH} onClick={onDelete}>
            Delete
          </Button>
        )}
      </div>
    </aside>
  )
}
