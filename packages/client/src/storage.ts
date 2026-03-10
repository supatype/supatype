import type { SupatypeError } from "./types.js"

// Storage support arrives in Phase 5.
// This stub keeps the client API surface stable.

export interface StorageObject {
  id: string
  name: string
  bucket_id: string
  owner?: string | undefined
  created_at: string
  updated_at: string
  last_accessed_at: string
  metadata?: Record<string, unknown> | undefined
}

export class StorageClient {
  private readonly url: string
  private readonly headers: Record<string, string>

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
  }

  from(bucket: string): BucketClient {
    return new BucketClient(this.url, bucket, this.headers)
  }
}

export class BucketClient {
  private readonly url: string
  private readonly bucket: string
  private readonly headers: Record<string, string>

  constructor(url: string, bucket: string, headers: Record<string, string>) {
    this.url = url
    this.bucket = bucket
    this.headers = headers
  }

  async upload(
    path: string,
    file: Blob | File | ArrayBuffer,
    options?: { contentType?: string | undefined; upsert?: boolean | undefined } | undefined,
  ): Promise<{ data: { path: string } | null; error: SupatypeError | null }> {
    const headers: Record<string, string> = {
      ...this.headers,
      "Content-Type": options?.contentType ?? "application/octet-stream",
    }
    if (options?.upsert === true) {
      headers["x-upsert"] = "true"
    }
    const res = await fetch(`${this.url}/object/${this.bucket}/${path}`, {
      method: "POST",
      headers,
      body: file,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Upload failed" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "Upload failed"), status: res.status } }
    }
    return { data: { path }, error: null }
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    return { data: { publicUrl: `${this.url}/object/public/${this.bucket}/${path}` } }
  }

  async remove(paths: string[]): Promise<{ data: StorageObject[] | null; error: SupatypeError | null }> {
    const res = await fetch(`${this.url}/object/${this.bucket}`, {
      method: "DELETE",
      headers: this.headers,
      body: JSON.stringify({ prefixes: paths }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Delete failed" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "Delete failed"), status: res.status } }
    }
    const json = await res.json() as StorageObject[]
    return { data: json, error: null }
  }

  async list(
    prefix?: string | undefined,
    options?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<{ data: StorageObject[] | null; error: SupatypeError | null }> {
    const body: Record<string, unknown> = {
      ...(prefix !== undefined && { prefix }),
      ...(options?.limit !== undefined && { limit: options.limit }),
      ...(options?.offset !== undefined && { offset: options.offset }),
    }
    const res = await fetch(`${this.url}/object/list/${this.bucket}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "List failed" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "List failed"), status: res.status } }
    }
    const json = await res.json() as StorageObject[]
    return { data: json, error: null }
  }
}
