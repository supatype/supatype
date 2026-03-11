import React, { useState, useRef } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { WidgetProps } from "./FieldWidget.js"

interface StorageRef {
  bucket: string
  path: string
  mimeType?: string
  size?: number
}

export function ImageWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const storageRef = value as StorageRef | null
  const bucket = (config.options?.["bucket"] as string) ?? "images"

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
        onChange({
          bucket,
          path,
          mimeType: file.type,
          size: file.size,
        })
      }
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith("image/")) {
      void handleUpload(file)
    }
  }

  const publicUrl = storageRef
    ? client.storage.from(storageRef.bucket).getPublicUrl(storageRef.path).data.publicUrl
    : null

  return (
    <div
      className={`st-image-widget${dragOver ? " st-image-widget--dragover" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={handleDrop}
    >
      {storageRef && publicUrl ? (
        <div className="st-image-preview">
          <img src={publicUrl} alt="" className="st-image-thumb" />
          {!readOnly && (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => { onChange(null) }}
            >
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="st-image-upload">
          {uploading ? (
            <span>Uploading...</span>
          ) : (
            <>
              <span>Drag an image here or</span>
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => { fileRef.current?.click() }}
                disabled={readOnly}
              >
                Browse
              </button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
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
