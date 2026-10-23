import { useState } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { StorageRef } from "../lib/storage-ref.js"

/** The first file chosen, uploaded; the rest are ignored, as a file or image field holds one. */
export const firstFileOf = (upload: (file: File) => Promise<void>) => (files: FileList): void => {
  const file = files[0]
  if (file) void upload(file)
}

/** A field's upload in progress, and the way to start one. */
export interface FieldUpload {
  uploading: boolean
  upload: (file: File) => Promise<void>
}

/**
 * Uploads a file a field was given into `bucket`, under the field's name with a timestamp so two
 * files of one name do not collide, and hands `commit` the stored file. A refused or failed upload
 * is logged and leaves the field as it was; the image and file widgets shared this, twice over.
 */
export function useFieldUpload(target: { field: string; bucket: string }, commit: (ref: StorageRef) => void): FieldUpload {
  const client = useAdminClient()
  const [uploading, setUploading] = useState(false)
  const upload = async (file: File): Promise<void> => {
    const { field, bucket } = target
    setUploading(true)
    try {
      const path = `${field}/${Date.now()}-${file.name}`
      const result = await client.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: true })
      if (result.error) console.error("Upload failed:", result.error.message)
      else commit({ bucket, path, mimeType: file.type, size: file.size })
    } catch (err) {
      console.error("Upload failed:", err instanceof Error ? err.message : err)
    } finally {
      setUploading(false)
    }
  }
  return { uploading, upload }
}
