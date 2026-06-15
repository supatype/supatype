import React, { useState, useRef, useEffect, useCallback } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { WidgetProps } from "./FieldWidget.js"
import type { StorageObject } from "@supatype/client"
import {
  parseStorageRef,
  resolveStorageObjectPath,
  storagePublicUrl,
  type StorageRef,
} from "../lib/storage-ref.js"
import { getLocalizedFieldValue, setLocalizedFieldValue } from "../lib/localized-field.js"

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"])

function isImageFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return IMAGE_EXTS.has(ext)
}

function isFolder(obj: StorageObject): boolean {
  return obj.id === null && obj.metadata == null
}

function isImageFile(obj: StorageObject): boolean {
  return !isFolder(obj) && isImageFileName(obj.name)
}

function BucketPickerModal({
  bucket,
  onSelect,
  onClose,
}: {
  bucket: string
  onSelect: (ref: StorageRef) => void
  onClose: () => void
}): React.ReactElement {
  const client = useAdminClient()
  const [prefix, setPrefix] = useState("")
  const [items, setItems] = useState<StorageObject[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (p: string) => {
    setLoading(true)
    try {
      const result = await client.storage.from(bucket).list(p, { limit: 200 })
      setItems(
        (result.data ?? []).filter((f) => f.name !== ".emptyFolderPlaceholder"),
      )
    } finally {
      setLoading(false)
    }
  }, [client, bucket])

  useEffect(() => { void load(prefix) }, [load, prefix])

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      const uploadPath = resolveStorageObjectPath(prefix, `${Date.now()}-${file.name}`)
      const result = await client.storage.from(bucket).upload(uploadPath, file, {
        contentType: file.type,
        upsert: true,
      })
      if (!result.error) {
        onSelect({ bucket, path: uploadPath, mimeType: file.type, size: file.size })
      }
    } finally {
      setUploading(false)
    }
  }

  const navigate = (folder: string) => {
    setPrefix(prefix ? `${prefix}/${folder}` : folder)
  }

  const navigateTo = (index: number) => {
    const parts = prefix.split("/")
    setPrefix(parts.slice(0, index + 1).join("/"))
  }

  const breadcrumbs = prefix ? prefix.split("/") : []
  const folders = items.filter(isFolder)
  const images = items.filter(isImageFile)
  const otherFiles = items.filter((f) => !isFolder(f) && !isImageFile(f))

  return (
    <div className="st-modal-overlay" onClick={onClose}>
      <div className="st-modal st-bucket-picker" onClick={(e) => e.stopPropagation()}>
        <div className="st-bucket-picker-header">
          <div className="st-bucket-picker-breadcrumb">
            <button
              type="button"
              className="st-bucket-picker-crumb"
              onClick={() => setPrefix("")}
            >
              {bucket}
            </button>
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={i}>
                <span className="st-bucket-picker-crumb-sep">/</span>
                <button
                  type="button"
                  className="st-bucket-picker-crumb"
                  onClick={() => navigateTo(i)}
                >
                  {crumb}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="st-bucket-picker-header-actions">
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || loading}
            >
              {uploading ? "Uploading…" : "Upload new"}
            </button>
            <button type="button" className="st-btn-icon" onClick={onClose} aria-label="Close">✕</button>
          </div>
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

        <div className="st-bucket-picker-body">
          {loading ? (
            <div className="st-bucket-picker-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="st-bucket-picker-empty">No files here yet. Upload one to get started.</div>
          ) : (
            <>
              {folders.length > 0 && (
                <div className="st-bucket-picker-section-label">Folders</div>
              )}
              {folders.length > 0 && (
                <div className="st-bucket-picker-folders">
                  {folders.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      className="st-bucket-picker-folder"
                      onClick={() => navigate(f.name)}
                    >
                      <span className="st-bucket-picker-folder-icon">📁</span>
                      <span>{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {images.length > 0 && (
                <div className="st-bucket-picker-section-label">Images</div>
              )}
              {images.length > 0 && (
                <div className="st-bucket-picker-grid">
                  {images.map((f) => {
                    const fullPath = resolveStorageObjectPath(prefix, f.name)
                    const thumbUrl = storagePublicUrl(client, { bucket, path: fullPath })
                    return (
                      <button
                        key={f.name}
                        type="button"
                        className="st-bucket-picker-item"
                        onClick={() => onSelect({ bucket, path: fullPath })}
                        title={f.name}
                      >
                        <img src={thumbUrl} alt={f.name} className="st-bucket-picker-thumb" />
                        <span className="st-bucket-picker-name">{f.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {otherFiles.length > 0 && (
                <div className="st-bucket-picker-empty" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                  {otherFiles.length} non-image file{otherFiles.length !== 1 ? "s" : ""} not shown.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function ImageWidget({
  config,
  value,
  onChange,
  readOnly,
  currentLocale = "en",
  defaultLocale = "en",
}: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const bucket = (config.options?.["bucket"] as string) ?? "images"
  const localeValue = getLocalizedFieldValue(
    value,
    config.localized,
    currentLocale,
    defaultLocale,
  )
  const storageRef = parseStorageRef(localeValue, bucket)

  const commitRef = (ref: StorageRef | null) => {
    onChange(
      setLocalizedFieldValue(value, config.localized, currentLocale, ref),
    )
  }

  useEffect(() => {
    if (!storageRef) {
      setPreviewUrl(null)
      return
    }

    let blobUrl: string | null = null
    let cancelled = false

    void (async () => {
      const { data, error } = await client.storage.from(storageRef.bucket).download(storageRef.path)
      if (cancelled) return
      if (data) {
        blobUrl = URL.createObjectURL(data)
        setPreviewUrl(blobUrl)
        return
      }
      if (error) {
        setPreviewUrl(storagePublicUrl(client, storageRef))
      }
    })()

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [client, storageRef?.bucket, storageRef?.path])

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
        commitRef({ bucket, path, mimeType: file.type, size: file.size })
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

  const displayUrl = previewUrl ?? (storageRef ? storagePublicUrl(client, storageRef) : null)

  return (
    <>
      <div
        className={`st-image-widget${dragOver ? " st-image-widget--dragover" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => { setDragOver(false) }}
        onDrop={handleDrop}
      >
        {storageRef && displayUrl ? (
          <div className="st-image-preview">
            <img src={displayUrl} alt="" className="st-image-thumb" />
            {!readOnly && (
              <div className="st-image-preview-actions">
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={() => { setPickerOpen(true) }}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={() => { commitRef(null) }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="st-image-upload">
            {uploading ? (
              <span>Uploading…</span>
            ) : (
              <>
                <span>Drag an image here, or</span>
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={() => { fileRef.current?.click() }}
                  disabled={readOnly}
                >
                  Upload
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={() => { setPickerOpen(true) }}
                  disabled={readOnly}
                >
                  Select from bucket
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
      {pickerOpen && (
        <BucketPickerModal
          bucket={bucket}
          onSelect={(ref) => {
            commitRef(ref)
            setPickerOpen(false)
          }}
          onClose={() => { setPickerOpen(false) }}
        />
      )}
    </>
  )
}
