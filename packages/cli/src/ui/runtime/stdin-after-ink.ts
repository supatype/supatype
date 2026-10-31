/** What these helpers use of stdin: a TTY stream, `process.stdin` unless a test passes another. */
export type InkStdin = Pick<NodeJS.ReadStream, "isTTY" | "pause"> & {
  isRaw?: boolean
  setRawMode?(mode: boolean): void
}

/** Restore stdin after Ink unmount so one-shot commands (init, link) can exit cleanly. */
export function restoreStdinAfterInk(stdin: InkStdin = process.stdin): void {
  if (!stdin.isTTY) return

  try {
    if (stdin.isRaw) stdin.setRawMode?.(false)
  } catch {
    // ignore: stdin may already be restored
  }

  // Pause so one-shot Ink flows (cache list, keys, …) can exit; resume() would keep the
  // process alive waiting for stdin on Windows Git Bash / MINGW64.
  stdin.pause()
  stopReading(stdin)
  process.stdout.write("\n")
}

/** The part of a TTY stream's native handle that says whether it reads, and starts and stops it. */
interface ReadingHandle {
  reading: boolean
  readStart(): number
  readStop(): number
}

function isReadingHandle(value: unknown): value is ReadingHandle {
  return (
    typeof value === "object" && value !== null && "reading" in value &&
    "readStart" in value && typeof value.readStart === "function" &&
    "readStop" in value && typeof value.readStop === "function"
  )
}

/** The stream's native handle, when it is a TTY's. */
function ttyHandle(stdin: InkStdin): ReadingHandle | null {
  if (!stdin.isTTY) return null
  const handle: unknown = Reflect.get(stdin, "_handle")
  return isReadingHandle(handle) ? handle : null
}

/**
 * Starts again the read {@link restoreStdinAfterInk} stopped, before a flow mounts: the stream
 * thinks it is still reading, so Ink asking it for input would not start it, and the flow would get
 * no keys. As Node's own `tryReadStart` does. Raw mode first: started with it off, on Windows the
 * read is a line-mode console read, which Ink turning raw mode on cancels, losing a key typed into
 * it (local test round 6, an answer to the second flow of a first dev).
 */
export function prepareStdinForInk(stdin: InkStdin = process.stdin): void {
  const handle = ttyHandle(stdin)
  if (handle === null || handle.reading) return
  stdin.setRawMode?.(true)
  handle.reading = true
  handle.readStart()
}

/**
 * Stops the console read itself, which `pause()` leaves running. Ink turns raw mode off while it
 * still reads, so on Windows libuv starts a line-mode read that only Enter ends, and it keeps the
 * process alive: after a second flow, `supatype link` printed its result and never exited (local
 * test round 5, N26). Node's own `Socket.pause` stops the handle this way; the next flow's read
 * starts it again.
 */
function stopReading(stdin: InkStdin): void {
  const handle = ttyHandle(stdin)
  if (handle === null || !handle.reading) return
  handle.reading = false
  handle.readStop()
}
