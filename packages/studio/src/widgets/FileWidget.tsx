import React, { useRef } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { parseStorageRef, type StorageRef } from "../lib/storage-ref.js"
import { stringOption } from "./field-options.js"
import { Button, DropZone, FileInput } from "../components/ui.js"
import { firstFileOf, useFieldUpload } from "./use-field-upload.js"

/** The stored file: its name and size, and Remove unless read only. */
function StoredFile({ file, onRemove }: { file: StorageRef; onRemove: (() => void) | null }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[0.85rem] font-medium">{file.path.split("/").pop()}</span>
      {file.size ? <span className="text-xs text-muted-foreground">({formatSize(file.size)})</span> : null}
      {onRemove !== null && (
        <Button type="button" size="xs" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}

export function FileWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const bucket = stringOption(config, "bucket") ?? "files"
  const storageRef = parseStorageRef(value, bucket)
  const { uploading, upload } = useFieldUpload({ field: config.name, bucket }, onChange)

  if (storageRef) return <StoredFile file={storageRef} onRemove={readOnly ? null : () => { onChange(null) }} />
  return (
    <DropZone className="p-4">
      {uploading ? (
        <span>Uploading...</span>
      ) : (
        <Button type="button" size="xs" onClick={() => { fileRef.current?.click() }} disabled={readOnly}>
          Choose file
        </Button>
      )}
      <FileInput ref={fileRef} aria-label={`${config.label} file`} onFiles={firstFileOf(upload)} />
    </DropZone>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
