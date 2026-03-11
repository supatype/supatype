import React, { useState, useRef } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { WidgetProps } from "./FieldWidget.js"

interface StorageRef {
  bucket: string
  path: string
  mimeType?: string
  size?: number
}

export function FileWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const storageRef = value as StorageRef | null
  const bucket = (config.options?.["bucket"] as string) ?? "files"

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      const path = `${config.name}/${Date.now()}-${file.name}`
      const result = await client.storage.from(bucket).upload(path, file, {
        contentType: file.type,
        upsert: true,
      })
      if (result.error) {
        console.error("Upload failed:", result.error.message)
      } else {
        onChange({ bucket, path, mimeType: file.type, size: file.size })
      }
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="st-file-widget">
      {storageRef ? (
        <div className="st-file-info">
          <span className="st-file-name">{storageRef.path.split("/").pop()}</span>
          {storageRef.size && <span className="st-file-size">({formatSize(storageRef.size)})</span>}
          {!readOnly && (
            <button type="button" className="st-btn st-btn-sm" onClick={() => { onChange(null) }}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="st-file-upload">
          {uploading ? (
            <span>Uploading...</span>
          ) : (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => { fileRef.current?.click() }}
              disabled={readOnly}
            >
              Choose file
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            className="st-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleUpload(file)
            }}
          />
        </div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
