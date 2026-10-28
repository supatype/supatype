import type { SupatypeError } from "./types.js"
import { transportFailure } from "./errors.js"
import { plainFetch, type RequestTransport } from "./fetch-with-retry.js"
import {
  isArrayOf,
  isBoolean,
  isJsonObject,
  isNumber,
  isShape,
  isString,
  nullable,
  readJson,
  readJsonObject,
  type Guard,
} from "./json.js"

/**
 * An object path as it goes into a URL: each segment encoded, the `/` between them kept, since the
 * server matches the path on it. Interpolated as given, a name holding `?` or `#` cut the URL short.
 */
function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

/**
 * An object as `list()` answers it, field for field (packages/storage/src/routes/objects.ts,
 * `listedObject`), named relative to the folder listed. A null is sent as null, never left out.
 */
export interface StorageObject {
  id: string
  bucket_id: string
  name: string
  /** The uploader's user id; null for an object stored without one, such as by the service role. */
  owner: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  last_accessed_at: string
  /** The object's size in bytes, from its metadata; null when the metadata records none. */
  size: number | null
  /** The content type it was stored with, from its metadata; null when the metadata records none. */
  mimetype: string | null
}

/**
 * A subfolder as `list()` answers it: only its bucket and its name, relative to the folder listed.
 * It has no row of its own, so every other field is null.
 */
export interface StorageFolder {
  id: null
  bucket_id: string
  name: string
  owner: null
  metadata: null
  created_at: null
  updated_at: null
  last_accessed_at: null
  size: null
  mimetype: null
}

/** What `list()` answers: a folder's subfolders, then its objects. */
export type StorageListEntry = StorageObject | StorageFolder

/** What to list besides the folder: a page, and a search of the entries' names. */
export interface ListOptions {
  /** Entries per page; the server's default is 100. */
  limit?: number | undefined
  offset?: number | undefined
  /** Matched case-insensitively against each entry's name; every character is literal. */
  search?: string | undefined
}

/** What `remove()` answers for each object it removed: one the caller may not delete is absent. */
export interface RemovedObject {
  name: string
  bucket_id: string
}

export interface TransformOptions {
  width?: number | undefined
  height?: number | undefined
  format?: "webp" | "avif" | "png" | "jpeg" | undefined
  quality?: number | undefined
  resize?: "cover" | "contain" | "fill" | "inside" | "outside" | undefined
}

/**
 * What an `ImageAsset` or `FileAsset` column stores: the bucket and path `upload()` wrote to.
 * Studio also records `mimeType` and `size` when it does the upload.
 */
export interface StorageReference {
  bucket: string
  path: string
  mimeType?: string | undefined
  size?: number | undefined
}

export interface StorageBucketMeta {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  created_at: string
  updated_at: string
}

/** Resolved fresh per request, so a session that arrives later is used. */
export type AuthHeaders = () => Promise<Record<string, string>>

/**
 * A bucket as the storage service lists it (`SELECT *` on storage.buckets).
 *
 * `file_size_limit` is a Postgres bigint, which node-postgres sends as a string, so the limit
 * arrived as `"1048576"` where `StorageBucketMeta` promises a number. It is read as a number here.
 */
const isBucketRows = isArrayOf(
  isShape({
    id: isString,
    name: isString,
    public: isBoolean,
    file_size_limit: nullable((value: unknown): value is number | string => isNumber(value) || isString(value)),
    allowed_mime_types: nullable(isArrayOf(isString)),
    created_at: isString,
    updated_at: isString,
  }),
)

async function readBuckets(res: Response): Promise<StorageBucketMeta[]> {
  const rows = await readJson(res, isBucketRows)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    public: row.public,
    file_size_limit: row.file_size_limit === null ? null : Number(row.file_size_limit),
    allowed_mime_types: row.allowed_mime_types,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

const isNull = (value: unknown): value is null => value === null

/** A subfolder entry: null in every field but its bucket and name. */
const isStorageFolder: Guard<StorageFolder> = isShape({
  id: isNull,
  bucket_id: isString,
  name: isString,
  owner: isNull,
  metadata: isNull,
  created_at: isNull,
  updated_at: isNull,
  last_accessed_at: isNull,
  size: isNull,
  mimetype: isNull,
})

/** An object entry: every declared field, checked. */
const isStorageObject: Guard<StorageObject> = isShape({
  id: isString,
  bucket_id: isString,
  name: isString,
  owner: nullable(isString),
  metadata: nullable(isJsonObject),
  created_at: isString,
  updated_at: isString,
  last_accessed_at: isString,
  size: nullable(isNumber),
  mimetype: nullable(isString),
})

/** The boundary between a `list` answer and `StorageListEntry`: every declared field, checked. */
const isStorageEntries: Guard<StorageListEntry[]> = isArrayOf(
  (value: unknown): value is StorageListEntry => isStorageFolder(value) || isStorageObject(value),
)

/** A total count header as a number, or null when it is absent or not a count. */
function countHeader(res: Response): number | null {
  const count = res.headers.get("X-Total-Count")
  return count !== null && /^\d+$/.test(count) ? Number(count) : null
}

/** The boundary between a `remove` answer and `RemovedObject`. */
const isRemovedObjects: Guard<RemovedObject[]> = isArrayOf(isShape({ name: isString, bucket_id: isString }))

/** A refusal's reason: the body's `message`, else its `error`, else `fallback`. */
async function storageRefusal(res: Response, fallback: string): Promise<string> {
  const body = await readJsonObject(res)
  return String(body["message"] ?? body["error"] ?? fallback)
}

export class StorageClient {
  private readonly url: string
  private readonly headers: AuthHeaders
  private readonly send: RequestTransport

  /**
   * Headers are asked for per request, not captured here.
   *
   * They used to be a plain object built when the client was constructed, which is before anybody
   * has signed in. Every storage request therefore carried the anon key for the life of the page,
   * whatever session the caller later had: an app's per-user storage policies saw `anon`, and
   * Studio's proxy refused the request outright because an anon key carries no subject.
   *
   * Every other client on this object already took the same function. Storage was the one that did
   * not.
   */
  constructor(url: string, headers: AuthHeaders, transport: RequestTransport = plainFetch) {
    this.send = transport
    this.url = url
    this.headers = headers
  }

  from(bucket: string): BucketClient {
    return new BucketClient(this.url, bucket, this.headers, this.send)
  }

  /**
   * The public URL of what an `ImageAsset` or `FileAsset` column holds.
   *
   * The column stores a {@link StorageReference}, never a URL: a stored URL goes stale and bakes in
   * the host, and the bucket and path rebuild it anywhere. This is that rebuild, so a component can
   * write `src={supatype.storage.publicUrl(speaker.headshot)}` instead of reading a `url` field that
   * is not there. Pass `transform` for a derivative resized or re-encoded on read.
   *
   * Null for an empty column or a reference without a bucket or path. Only meaningful for a public
   * bucket; a private one needs `from(bucket).createSignedUrl(path)`.
   */
  publicUrl(
    reference: StorageReference | null | undefined,
    options?: { transform?: TransformOptions | undefined } | undefined,
  ): string | null {
    if (reference === null || reference === undefined) return null
    const { bucket, path } = reference
    if (typeof bucket !== "string" || bucket === "" || typeof path !== "string" || path === "") return null
    return this.from(bucket).getPublicUrl(path, options).data.publicUrl
  }

  async listBuckets(): Promise<{ data: StorageBucketMeta[] | null; error: SupatypeError | null }> {
    try {
      const res = await this.send(`${this.url}/bucket`, { headers: await this.headers() })
      if (!res.ok) return { data: null, error: { message: await storageRefusal(res, "Failed to list buckets") } }
      return { data: await readBuckets(res), error: null }
    } catch (e) {
      return { data: null, error: transportFailure(e) }
    }
  }

  async createBucket(
    name: string,
    options?: { public?: boolean | undefined; fileSizeLimit?: number | undefined; allowedMimeTypes?: string[] | undefined } | undefined,
  ): Promise<{ data: { name: string } | null; error: SupatypeError | null }> {
    try {
      const body: Record<string, unknown> = {
        id: name,
        name,
        ...(options?.public !== undefined && { public: options.public }),
        ...(options?.fileSizeLimit !== undefined && { file_size_limit: options.fileSizeLimit }),
        ...(options?.allowedMimeTypes !== undefined && { allowed_mime_types: options.allowedMimeTypes }),
      }
      const res = await this.send(`${this.url}/bucket`, {
        method: "POST",
        headers: { ...(await this.headers()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) return { data: null, error: { message: await storageRefusal(res, "Failed to create bucket") } }
      return { data: { name }, error: null }
    } catch (e) {
      return { data: null, error: transportFailure(e) }
    }
  }
}

export class BucketClient {
  private readonly url: string
  private readonly bucket: string
  private readonly headers: AuthHeaders
  private readonly send: RequestTransport

  constructor(url: string, bucket: string, headers: AuthHeaders, transport: RequestTransport = plainFetch) {
    this.send = transport
    this.url = url
    this.bucket = bucket
    this.headers = headers
  }

  async upload(
    path: string,
    file: Blob | File | ArrayBuffer,
    options?: { contentType?: string | undefined; upsert?: boolean | undefined } | undefined,
  ): Promise<{ data: { path: string } | null; error: SupatypeError | null }> {
    const inferredType = file instanceof File && file.type ? file.type : "application/octet-stream"
    const headers: Record<string, string> = {
      ...(await this.headers()),
      "Content-Type": options?.contentType ?? inferredType,
    }
    if (options?.upsert === true) {
      headers["x-upsert"] = "true"
    }
    const res = await this.send(`${this.url}/object/${this.bucket}/${encodeObjectPath(path)}`, {
      method: "POST",
      headers,
      body: file,
    })
    if (!res.ok) {
      return { data: null, error: { message: await storageRefusal(res, "Upload failed"), status: res.status } }
    }
    return { data: { path }, error: null }
  }

  async download(
    path: string,
    options?: { transform?: TransformOptions | undefined } | undefined,
  ): Promise<{ data: Blob | null; error: SupatypeError | null }> {
    const url = this.buildObjectUrl("authenticated", path, options?.transform)
    const res = await this.send(url, { headers: await this.headers() })
    if (!res.ok) {
      return { data: null, error: { message: await storageRefusal(res, "Download failed"), status: res.status } }
    }
    const blob = await res.blob()
    return { data: blob, error: null }
  }

  getPublicUrl(
    path: string,
    options?: { transform?: TransformOptions | undefined } | undefined,
  ): { data: { publicUrl: string } } {
    const publicUrl = this.buildObjectUrl("public", path, options?.transform)
    return { data: { publicUrl } }
  }

  /**
   * Resolve what the storage API returned against this client's base URL.
   *
   * `getPublicUrl` hands back something fetchable; this used to hand back the server's response
   * verbatim, and the server answers with a path (`/object/sign/...`). So one of the two URL
   * methods returned a URL and the other returned half of one, which fails at the caller as
   * `TypeError: Failed to parse URL` rather than anywhere near here.
   *
   * Absolute answers are passed through untouched, so a deployment whose storage API returns a
   * full URL (a CDN, a signed S3 link) is not mangled by being prefixed a second time.
   */
  private absoluteObjectUrl(value: string): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    return `${this.url.replace(/\/$/, "")}/${value.replace(/^\//, "")}`
  }

  async createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: SupatypeError | null }> {
    const res = await this.send(`${this.url}/object/sign/${this.bucket}/${encodeObjectPath(path)}`, {
      method: "POST",
      // Signing creates nothing on the server, so a second request is harmless.
      idempotent: true,
      headers: { ...(await this.headers()), "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    })
    if (!res.ok) {
      return { data: null, error: { message: await storageRefusal(res, "Failed to create signed URL"), status: res.status } }
    }
    const json = await readJson(res, isShape({ signedURL: isString }))
    return { data: { signedUrl: this.absoluteObjectUrl(json.signedURL) }, error: null }
  }

  async createSignedUrls(
    paths: string[],
    expiresIn: number,
  ): Promise<{ data: { path: string; signedUrl: string; error: string | null }[] | null; error: SupatypeError | null }> {
    const results = await Promise.all(
      paths.map(async (path) => {
        const result = await this.createSignedUrl(path, expiresIn)
        if (result.error) {
          return { path, signedUrl: "", error: result.error.message }
        }
        return { path, signedUrl: result.data!.signedUrl, error: null }
      }),
    )
    return { data: results, error: null }
  }

  async remove(paths: string[]): Promise<{ data: RemovedObject[] | null; error: SupatypeError | null }> {
    const res = await this.send(`${this.url}/object/${this.bucket}`, {
      method: "DELETE",
      headers: { ...(await this.headers()), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: paths }),
    })
    if (!res.ok) {
      return { data: null, error: { message: await storageRefusal(res, "Delete failed"), status: res.status } }
    }
    return { data: await readJson(res, isRemovedObjects), error: null }
  }

  /**
   * The folder `prefix` names ("" or none for the bucket root): its subfolders, then its objects, each
   * named relative to it. `count` is how many entries match in all, before `limit` and `offset`,
   * or null from a server that does not send it.
   */
  async list(
    prefix?: string | undefined,
    options?: ListOptions | undefined,
  ): Promise<{ data: StorageListEntry[] | null; count: number | null; error: SupatypeError | null }> {
    const body: Record<string, unknown> = {
      ...(prefix !== undefined && { prefix }),
      ...(options?.search !== undefined && { search: options.search }),
      ...(options?.limit !== undefined && { limit: options.limit }),
      ...(options?.offset !== undefined && { offset: options.offset }),
    }
    const res = await this.send(`${this.url}/object/list/${this.bucket}`, {
      method: "POST",
      // A read that happens to be sent as POST.
      idempotent: true,
      headers: { ...(await this.headers()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { data: null, count: null, error: { message: await storageRefusal(res, "List failed"), status: res.status } }
    }
    return { data: await readJson(res, isStorageEntries), count: countHeader(res), error: null }
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private buildObjectUrl(
    access: "public" | "authenticated",
    path: string,
    transform?: TransformOptions | undefined,
  ): string {
    let url = `${this.url}/object/${access}/${this.bucket}/${encodeObjectPath(path)}`
    if (transform) {
      const params = new URLSearchParams()
      if (transform.width !== undefined) params.set("width", String(transform.width))
      if (transform.height !== undefined) params.set("height", String(transform.height))
      if (transform.format !== undefined) params.set("format", transform.format)
      if (transform.quality !== undefined) params.set("quality", String(transform.quality))
      if (transform.resize !== undefined) params.set("resize", transform.resize)
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }
    return url
  }
}
