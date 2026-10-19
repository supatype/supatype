import type { SupatypeClient } from "@supatype/client"
import { isJsonObject } from "./json.js"

export interface StorageRef {
  bucket: string
  path: string
  mimeType?: string
  size?: number
}

/** Normalize PostgREST JSONB, JSON strings, or legacy `/assets/...` paths into a storage ref. */
export function parseStorageRef(value: unknown, fallbackBucket?: string): StorageRef | null {
  if (value == null) return null

  // An array names no file, and falls through to the `null` at the end.
  if (isJsonObject(value)) {
    const row = value
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
        return parseStorageRef(JSON.parse(trimmed), fallbackBucket)
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

/** Studio's session proxy. It holds the service key, so it answers only requests carrying the Studio session. */
const SESSION_PROXY = "/studio/proxy"
const STORAGE_API = "/storage/v1/"

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** The gateway a browser reaches on its own: the client's URL without Studio's session proxy. */
function gatewayBase(clientUrl: string): string {
  const base = clientUrl.replace(/\/+$/, "")
  return base.endsWith(SESSION_PROXY) ? base.slice(0, -SESSION_PROXY.length) : base
}

/**
 * A storage URL a browser loads with no headers of its own: an `<img>`, a link, a new tab.
 *
 * `getPublicUrl` and `createSignedUrl` build on the client's URL, which in Studio is the session
 * proxy, and an `<img>` cannot send the Studio session: every thumbnail answered 401. A public
 * bucket or a signed token is its own credential, so those reads go to the gateway's
 * `/storage/v1/` route instead. A URL a storage server built for another origin (its internal
 * host) is moved to the gateway too. Anything else is returned as it came.
 */
export function browserStorageUrl(clientUrl: string, rawUrl: string): string {
  const base = clientUrl.replace(/\/+$/, "")
  const gateway = gatewayBase(base)
  if (rawUrl.startsWith(`${base}${STORAGE_API}`)) return `${gateway}${rawUrl.slice(base.length)}`
  const parsed = parsedUrl(rawUrl)
  if (parsed === null || !parsed.pathname.startsWith(STORAGE_API)) return rawUrl
  if (parsed.origin === parsedUrl(gateway)?.origin) return rawUrl
  return `${gateway}${parsed.pathname}${parsed.search}`
}

export function storagePublicUrl(client: SupatypeClient, ref: StorageRef): string {
  return browserStorageUrl(client.url, client.storage.from(ref.bucket).getPublicUrl(ref.path).data.publicUrl)
}

/** A signed URL to one object that a browser loads on its own, or why the server would not sign one. */
export async function browserSignedUrl(
  client: SupatypeClient,
  ref: StorageRef,
  expiresIn: number,
): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await client.storage.from(ref.bucket).createSignedUrl(ref.path, expiresIn)
  if (error !== null) return { url: null, error: error.message }
  return { url: data === null ? null : browserStorageUrl(client.url, data.signedUrl), error: null }
}
