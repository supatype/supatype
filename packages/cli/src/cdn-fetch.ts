/**
 * One way to GET a release file from the CDN: a per-request timeout, and a failure that names the
 * URL and says retrying is reasonable. Without the timeout a stalled connection hung the CLI
 * forever, and a bare "fetch failed" named nothing.
 */

/** Time allowed for a small file (latest.json, checksums, signature). */
export const METADATA_TIMEOUT_MS = 15_000
/** Time allowed for an archive, which is megabytes rather than bytes. */
export const ARCHIVE_TIMEOUT_MS = 120_000

/** SUPATYPE_FETCH_TIMEOUT_MS, when set, replaces both limits (tests, very slow links). */
function timeoutFor(defaultMs: number): number {
  const raw = Number(process.env["SUPATYPE_FETCH_TIMEOUT_MS"])
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs
}

/** A response whose body has been read, so the timeout covers the whole transfer. */
export interface CdnResponse {
  readonly status: number
  readonly ok: boolean
  readonly bytes: Buffer
  text(): string
}

export async function cdnGet(url: string, defaultTimeoutMs = METADATA_TIMEOUT_MS): Promise<CdnResponse> {
  const timeoutMs = timeoutFor(defaultTimeoutMs)
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const bytes = Buffer.from(await resp.arrayBuffer())
    return { status: resp.status, ok: resp.ok, bytes, text: () => bytes.toString("utf8") }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    const reason = timedOut
      ? `no complete response within ${Math.round(timeoutMs / 1000)}s`
      : err instanceof Error ? err.message : String(err)
    throw new Error(`Could not fetch ${url}: ${reason}. This is usually a network or CDN blip; try again.`)
  }
}
