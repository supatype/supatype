/**
 * Engine binary download with progress bar, retry, and proxy support.
 */

import { createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export interface DownloadOptions {
  url: string
  dest: string
  showProgress?: boolean
  label?: string
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 3000, 10000]

/**
 * Download a file with retry and optional progress bar.
 * Respects HTTP_PROXY / HTTPS_PROXY environment variables.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { url, dest, showProgress = false, label } = options
  let lastError: Error | undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await doDownload(url, dest, showProgress, label)
      return
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt]!
        process.stderr.write(
          `Download failed. Retrying (${attempt + 2}/${MAX_RETRIES})...\n`,
        )
        await sleep(delay)
      }
    }
  }

  throw new Error(
    `Failed to download after ${MAX_RETRIES} attempts: ${lastError?.message}`,
  )
}

async function doDownload(
  url: string,
  dest: string,
  showProgress: boolean,
  label?: string,
): Promise<void> {
  const fetchOptions = buildFetchOptions(url)
  const res = await fetch(url, fetchOptions)

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`)
  }

  if (!res.body) {
    throw new Error(`No response body: ${url}`)
  }

  const contentLength = Number(res.headers.get("content-length") || 0)
  const out = createWriteStream(dest)

  if (showProgress && contentLength > 0 && process.stderr.isTTY) {
    const progressStream = createProgressStream(contentLength, label)
    await pipeline(Readable.fromWeb(res.body as any), progressStream, out)
    // Clear the progress line
    process.stderr.write("\n")
  } else {
    if (showProgress && label) {
      process.stderr.write(`${label}...\n`)
    }
    await pipeline(Readable.fromWeb(res.body as any), out)
  }
}

/**
 * Build fetch options respecting proxy env vars.
 */
function buildFetchOptions(url: string): RequestInit {
  const opts: RequestInit = {}

  // Node.js 18+ fetch supports the proxy via undici dispatcher.
  // For simplicity, we rely on the global-agent or undici proxy support.
  // The user should set HTTPS_PROXY or HTTP_PROXY env vars.
  // Node.js 22+ automatically respects these in fetch().
  //
  // For older Node.js, users can install global-agent or similar.

  return opts
}

/**
 * Creates a Transform stream that logs download progress to stderr.
 */
function createProgressStream(
  totalBytes: number,
  label?: string,
): import("node:stream").Transform {
  const { Transform } = require("node:stream") as typeof import("node:stream")
  let downloaded = 0

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length
      const percent = Math.round((downloaded / totalBytes) * 100)
      const mb = (downloaded / (1024 * 1024)).toFixed(1)
      const totalMb = (totalBytes / (1024 * 1024)).toFixed(1)
      const barWidth = 30
      const filled = Math.round((percent / 100) * barWidth)
      const bar = "=".repeat(filled) + " ".repeat(barWidth - filled)

      const prefix = label || "Downloading"
      process.stderr.write(
        `\r${prefix} ${mb}MB/${totalMb}MB [${bar}] ${percent}%`,
      )

      this.push(chunk)
      callback()
    },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch a JSON file from a URL. Returns undefined on failure.
 */
export async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}
