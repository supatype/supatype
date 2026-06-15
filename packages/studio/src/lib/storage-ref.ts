import type { SupatypeClient } from "@supatype/client"

export interface StorageRef {
  bucket: string
  path: string
  mimeType?: string
  size?: number
}

/** Normalize PostgREST JSONB, JSON strings, or legacy `/assets/...` paths into a storage ref. */
export function parseStorageRef(value: unknown, fallbackBucket?: string): StorageRef | null {
  if (value == null) return null

  if (typeof value === "object") {
    const row = value as Record<string, unknown>
    const bucket = String(row["bucket"] ?? fallbackBucket ?? "")
    const path = String(row["path"] ?? "")
    if (!bucket || !path) return null
    return {
      bucket,
      path,
      ...(row["mimeType"] !== undefined ? { mimeType: String(row["mimeType"]) } : {}),
      ...(row["size"] !== undefined ? { size: Number(row["size"]) } : {}),
    }
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (trimmed.startsWith("{")) {
      try {
        return parseStorageRef(JSON.parse(trimmed) as unknown, fallbackBucket)
      } catch {
        return null
      }
    }
    const bucket = fallbackBucket ?? "marketing"
    if (trimmed.startsWith("/assets/images/")) {
      return { bucket, path: trimmed.replace(/^\/assets\/images\//, "images/") }
    }
    if (trimmed.startsWith("/")) {
      return { bucket, path: trimmed.replace(/^\//, "") }
    }
    return { bucket, path: trimmed }
  }

  return null
}

/** Build bucket object key from folder prefix + list item name (list API returns full keys). */
export function resolveStorageObjectPath(prefix: string, name: string): string {
  const pathStr = prefix.replace(/\/+$/, "")
  if (pathStr === "") return name
  if (name.startsWith(`${pathStr}/`)) return name
  return `${pathStr}/${name}`
}

export function storagePublicUrl(client: SupatypeClient, ref: StorageRef): string {
  const raw = client.storage.from(ref.bucket).getPublicUrl(ref.path).data.publicUrl
  try {
    const parsed = new URL(raw)
    const apiOrigin = typeof client.url === "string" ? new URL(client.url).origin : null
    if (apiOrigin && parsed.origin !== apiOrigin && parsed.pathname.startsWith("/storage/v1/")) {
      return `${apiOrigin}${parsed.pathname}${parsed.search}`
    }
    return raw
  } catch {
    return raw
  }
}
