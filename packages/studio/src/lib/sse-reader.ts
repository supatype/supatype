/**
 * Server-Sent Events, read from a `fetch` body.
 *
 * Studio reads its live streams (function log tails, the Realtime Inspector) with `fetch` rather
 * than `EventSource`, because `EventSource` cannot send the session in a header and a token in a
 * query string lands in access logs. This is the part of the protocol those readers share.
 */

import { safeParseJson, type Guard } from "./json.js"

/** One event: its name (`message` when the stream gave none) and its data lines, joined. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * Split a stream buffer into the events it completes, keeping whatever is unfinished.
 *
 * An event can be cut anywhere by the network, so what follows the last blank line is handed back
 * as `rest` for the next chunk. Comment lines (`: ping`) and `retry:` or `id:` fields are protocol,
 * not content, and an event with no data line is not one at all.
 */
export function parseSseEvents(buffered: string): { events: SseEvent[]; rest: string } {
  const blocks = buffered.replace(/\r\n/g, "\n").split("\n\n")
  const rest = blocks.pop() ?? ""
  const events: SseEvent[] = []

  for (const block of blocks) {
    let event = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") })
  }
  return { events, rest }
}

/**
 * The data of an event as JSON the guard accepts, or null when it is not JSON or not that shape:
 * one bad line must not end a stream.
 */
export function sseJson<T>(event: SseEvent, guard: Guard<T>): T | null {
  const value = safeParseJson(event.data)
  return guard(value) ? value : null
}

/**
 * Read `body` to its end, handing each complete event to `onEvent` in order.
 *
 * Resolves when the stream ends; rejects when reading fails, unless `signal` aborted it, which is
 * the caller closing the stream and resolves quietly.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseEvents(buffered)
      buffered = rest
      for (const event of events) onEvent(event)
    }
  } catch (err) {
    if (signal?.aborted === true) return
    throw err
  }
}
