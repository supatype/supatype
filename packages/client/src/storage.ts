import type { SupatypeError } from "./types.js"

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

export interface TransformOptions {
  width?: number | undefined
  height?: number | undefined
  format?: "webp" | "avif" | "png" | "jpeg" | undefined
  quality?: number | undefined
  resize?: "cover" | "contain" | "fill" | "inside" | "outside" | undefined
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

  async download(
    path: string,
    options?: { transform?: TransformOptions | undefined } | undefined,
  ): Promise<{ data: Blob | null; error: SupatypeError | null }> {
    const url = this.buildObjectUrl("authenticated", path, options?.transform)
    const res = await fetch(url, { headers: this.headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Download failed" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "Download failed"), status: res.status } }
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

  async createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: SupatypeError | null }> {
    const res = await fetch(`${this.url}/object/sign/${this.bucket}/${path}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Failed to create signed URL" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "Failed to create signed URL"), status: res.status } }
    }
    const json = await res.json() as { signedURL: string }
    return { data: { signedUrl: json.signedURL }, error: null }
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

  async remove(paths: string[]): Promise<{ data: StorageObject[] | null; error: SupatypeError | null }> {
    const res = await fetch(`${this.url}/object/${this.bucket}`, {
      method: "DELETE",
      headers: { ...this.headers, "Content-Type": "application/json" },
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
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "List failed" })) as Record<string, unknown>
      return { data: null, error: { message: String(err["message"] ?? "List failed"), status: res.status } }
    }
    const json = await res.json() as StorageObject[]
    return { data: json, error: null }
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private buildObjectUrl(
    access: "public" | "authenticated",
    path: string,
    transform?: TransformOptions | undefined,
  ): string {
    let url = `${this.url}/object/${access}/${this.bucket}/${path}`
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
