import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * The admin API's envelope, the same one the self-host control plane answers with: `{ data }` on
 * success, `{ error, message }` on failure.
 */

export function sendData(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ data }))
}

export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify({ error, message }))
}

/** A request refused before it did anything, answered as {@link sendError}. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = "AdminError"
  }
}

/**
 * The request body as text, refusing one larger than `maxBytes` without reading the rest.
 *
 * Bounded so a caller holding the service role still cannot make this process buffer an arbitrary
 * amount: past the limit the rest is read and discarded, not kept, and the request is refused once
 * it has arrived, so the caller reads a 413 rather than a reset connection.
 */
export function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= maxBytes) chunks.push(chunk)
    })
    req.on("end", () => {
      if (size > maxBytes) {
        reject(new AdminError(413, "payload_too_large", `The request body is over ${maxBytes} bytes`))
        return
      }
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}
