/**
 * One way to GET a release file from the CDN.
 *
 * A request fails when no bytes have arrived for the stall window (60 s), counted from the request
 * and again from every chunk, and never because the whole transfer took long: a slow link finishing
 * an archive is working, and a connection that went quiet is not. A failure names the URL and says
 * retrying is reasonable. A retry of a download resumes from the bytes already on disk.
 */
import { closeSync, existsSync, openSync, rmSync, statSync, writeSync } from "node:fs"
import { progress } from "./ui/messages.js"
import { getActiveFlowApi } from "./ui/runtime/flow-session.js"

/** How long a request may go without receiving a byte. */
export const STALL_WINDOW_MS = 60_000

/** The server answered, with a status that is not a success. `status` is what it said. */
export class CdnHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "CdnHttpError"
  }
}

/** No answer came: the connection failed or dropped, or went quiet for the stall window. */
export class CdnNetworkError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options)
    this.name = "CdnNetworkError"
  }
}

/**
 * Whether a request failed for a reason another host may not share: a 5xx, or no answer at all.
 * A 4xx (a missing file is a 404 on every host) and anything the caller finds wrong with bytes it
 * did receive, a checksum mismatch included, are not.
 */
export function isHostUnavailable(err: unknown): boolean {
  return err instanceof CdnNetworkError || (err instanceof CdnHttpError && err.status >= 500)
}

/** SUPATYPE_FETCH_TIMEOUT_MS, when set, is the stall window (tests, very slow links). */
function stallWindowMs(): number {
  const raw = Number(process.env["SUPATYPE_FETCH_TIMEOUT_MS"])
  return Number.isFinite(raw) && raw > 0 ? raw : STALL_WINDOW_MS
}

/**
 * Run one request under the stall rule. `run` gets a signal to pass to `fetch` and a `touch` to call
 * whenever bytes arrive; the window restarts on each call and aborts the request when it runs out.
 */
async function withStall<T>(url: string, run: (signal: AbortSignal, touch: () => void) => Promise<T>): Promise<T> {
  const windowMs = stallWindowMs()
  const controller = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, windowMs)
  }
  touch()
  try {
    return await run(controller.signal, touch)
  } catch (err) {
    const reason = stalled ? `no data for ${windowMs / 1000}s` : err instanceof Error ? err.message : String(err)
    const message = `Could not fetch ${url}: ${reason}. This is usually a network or CDN blip; try again.`
    if (err instanceof CdnHttpError) throw new CdnHttpError(message, err.status)
    // fetch rejects with a TypeError when the connection fails or drops, mid-body included.
    if (stalled || err instanceof TypeError) throw new CdnNetworkError(message, { cause: err })
    throw new Error(message, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}

/** A response whose body has been read. */
export interface CdnResponse {
  readonly status: number
  readonly ok: boolean
  readonly bytes: Buffer
  text(): string
}

/** Every chunk of a fetch body, calling `onChunk` for each. Node types the chunks `any`, so each is checked. */
async function forEachChunk(
  resp: Response,
  url: string,
  touch: () => void,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  if (resp.body === null) return
  const reader = resp.body.getReader()
  for (;;) {
    const next: { done: boolean; value?: unknown } = await reader.read()
    if (next.done) return
    if (!(next.value instanceof Uint8Array)) throw new Error(`${url} yielded a chunk that is not bytes`)
    touch()
    onChunk(next.value)
  }
}

/** A small file (latest.json, checksums, signature) read whole. */
export async function cdnGet(url: string): Promise<CdnResponse> {
  return withStall(url, async (signal, touch) => {
    const resp = await fetch(url, { signal })
    touch()
    const chunks: Buffer[] = []
    await forEachChunk(resp, url, touch, (c) => chunks.push(Buffer.from(c)))
    const bytes = Buffer.concat(chunks)
    return { status: resp.status, ok: resp.ok, bytes, text: () => bytes.toString("utf8") }
  })
}

/** Where a download resumes: the bytes the server sends, and how many the whole file will be. */
interface Landing {
  /** Offset the body starts at: the bytes already on disk for a 206, zero for a 200. */
  offset: number
  total: number | null
}

function landingOf(resp: Response, have: number): Landing {
  const length = Number(resp.headers.get("content-length"))
  const sent = Number.isFinite(length) && length > 0 ? length : null
  if (resp.status === 206) {
    const total = /\/(\d+)$/.exec(resp.headers.get("content-range") ?? "")?.[1]
    return { offset: have, total: total !== undefined ? Number(total) : sent === null ? null : have + sent }
  }
  return { offset: 0, total: sent }
}

/** `18 / 46 MB` in place on a bare terminal, a start and an end line anywhere else. */
function downloadProgress(label: string, landing: Landing): { update: (bytes: number) => void; done: () => void } {
  // In place only on a bare terminal: under a flow the line would land in the spinner's, and a log
  // line cannot be rewritten, so the flow gets a start and an end line through progress().
  const tty = process.stdout.isTTY === true && getActiveFlowApi() === null
  const mb = (n: number): string => (n / 1_000_000).toFixed(1)
  const size = landing.total === null ? "" : ` (${mb(landing.total)} MB)`
  if (!tty) progress(`Downloading ${label}${size}...`)
  let last = 0
  return {
    update: (bytes) => {
      const now = Date.now()
      if (!tty || (now - last < 100 && bytes !== landing.total)) return
      last = now
      const of = landing.total === null ? "" : ` / ${mb(landing.total)}`
      process.stdout.write(`\r[supatype] Downloading ${label}: ${mb(bytes)}${of} MB`)
    },
    done: () => {
      if (tty) process.stdout.write("\n")
      else progress(`Downloaded ${label}.`)
    },
  }
}

/**
 * Download `url` into `destPath`, one attempt. Resumes with a Range request from the bytes already
 * in the file, so a retry (see withRetry) carries on rather than starting over; a server that
 * answers 200 instead of 206 gets the file rewritten from zero. The caller removes a file left by
 * an earlier run first, and verifies the complete file.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  const have = existsSync(destPath) ? statSync(destPath).size : 0
  await withStall(url, async (signal, touch) => {
    const resp = await fetch(url, { signal, headers: have > 0 ? { Range: `bytes=${have}-` } : {} })
    touch()
    // 416: the file on disk is not a prefix of what the server holds. Start again on the retry.
    if (resp.status === 416) rmSync(destPath, { force: true })
    if (!resp.ok) throw new CdnHttpError(`HTTP ${resp.status}`, resp.status)
    await writeBody(resp, url, destPath, label, have, touch)
  })
}

async function writeBody(
  resp: Response,
  url: string,
  destPath: string,
  label: string,
  have: number,
  touch: () => void,
): Promise<void> {
  const landing = landingOf(resp, have)
  const bar = downloadProgress(label, landing)
  let written = landing.offset
  const fd = openSync(destPath, landing.offset > 0 ? "a" : "w")
  try {
    await forEachChunk(resp, url, touch, (chunk) => {
      writeSync(fd, chunk)
      written += chunk.length
      bar.update(written)
    })
  } finally {
    closeSync(fd)
  }
  bar.done()
}
