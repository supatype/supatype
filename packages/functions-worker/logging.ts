import { currentInvocation } from "./invocation.ts"

/**
 * Structured invocation logging, and a live tail over it.
 *
 * # Why structured, and why this exact shape
 *
 * The worker used to write `GET /functions/v1/foo → 200 (12ms)` to its own stdout and nothing else.
 * On cloud, `infra/k8s/platform/logging.yaml` runs Promtail into Loki with a pipeline that parses
 * each line as JSON and labels on `project_ref`, `service` and `level`, taking the timestamp from a
 * `timestamp` field in Go's `2006-01-02T15:04:05.000Z` layout. A plain-text line survives none of
 * that: it is collected, matches no expression, and is indexed under no project.
 *
 * So the fields below are not a taste; they are the contract that pipeline already expects.
 * `toISOString()` produces exactly three fractional digits and a `Z`, which is that layout.
 *
 * # Why a tail rather than a store
 *
 * Cloud has Loki, with retention per tier. Self-host has eleven services and no log store, and
 * adding one changes the footprint of every self-hosted deployment, so for release the self-host
 * answer is a live tail: attach, see what happens while attached, detach. Nothing is written down,
 * nothing lands in the project's own Postgres, and no service is added.
 *
 * The ring buffer exists only so that attaching does not start from an empty screen.
 *
 * # Why the context comes from AsyncLocalStorage
 *
 * `console` is global and invocations now genuinely run concurrently, so a captured line has to be
 * attributed to the invocation that wrote it rather than to whichever one happens to be current. A
 * module-level "current request" would mis-attribute every interleaved line.
 *
 * The store is `invocation.ts`, shared with the context a handler is passed, so a log line and the
 * function that wrote it cannot disagree about which call they belong to.
 */

/** What every line carries, whether the worker wrote it or a function did. */
export interface LogLine {
  timestamp: string
  level: "debug" | "info" | "warn" | "error"
  service: "functions-worker"
  project_ref: string
  /** The invocation, or absent for a line the worker wrote outside one. */
  request_id?: string
  /** The function or hook route, when there is one. */
  function?: string
  message: string
  /** Present on the line that completes an invocation. */
  duration_ms?: number
  status?: number
}

/**
 * The real console methods, captured before anything is patched.
 *
 * Emitting through the patched `console` would call the patch again, which is an unbounded
 * recursion that takes the worker down on its first log line.
 */
const realConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

function projectRef(): string {
  const env = (key: string): string => Deno.env.get(key)?.trim() ?? ""
  // Self-host sets the first; cloud's templates use the managed and dedicated spellings. Falling
  // back to "unknown" rather than "" keeps the Loki label present, since a line with no
  // `project_ref` is indexed under no project and is effectively lost.
  return env("SUPATYPE_PROJECT_REF") || env("SUPATYPE_MANAGED_PROJECT_REF") || env("DEDICATED_PROJECT_REF") || "unknown"
}

const TAIL_BUFFER_LINES = Math.max(
  0,
  parseInt(Deno.env.get("SUPATYPE_LOG_TAIL_BUFFER") ?? "500", 10) || 500,
)

const buffer: LogLine[] = []
const subscribers = new Set<(line: LogLine) => void>()

function record(line: LogLine): void {
  if (TAIL_BUFFER_LINES > 0) {
    buffer.push(line)
    if (buffer.length > TAIL_BUFFER_LINES) buffer.shift()
  }
  for (const send of subscribers) {
    try {
      send(line)
    } catch {
      // A subscriber whose stream has gone is removed when its cancel handler runs. Throwing here
      // would lose the line for everybody else, and drop it from stdout too.
    }
  }
}

/** Everything except the message, so a caller only has to supply what it knows. */
function baseLine(level: LogLine["level"]): Omit<LogLine, "message"> {
  const current = currentInvocation()
  return {
    timestamp: new Date().toISOString(),
    level,
    service: "functions-worker",
    project_ref: projectRef(),
    ...(current !== undefined && {
      request_id: current.executionId,
      function: current.functionName,
    }),
  }
}

/** Write one line as JSON on stdout, and give it to anybody tailing. */
export function emit(line: LogLine): void {
  record(line)
  const write = line.level === "error" ? realConsole.error : realConsole.log
  write(JSON.stringify(line))
}

/** A line the worker itself is writing, at this level, inside whatever invocation is current. */
export function log(level: LogLine["level"], message: string, extra: Partial<LogLine> = {}): void {
  emit({ ...baseLine(level), message, ...extra })
}

/**
 * Replace `console` so that a function's own output is structured and attributable.
 *
 * A function author writes `console.log("saved", id)` and expects it to appear. It used to reach the
 * container's stdout unstructured and unlabelled, so on cloud it was dropped by the pipeline and on
 * self-host it was mixed in with every other invocation's output with nothing to tell them apart.
 *
 * Arguments are formatted the way a console does rather than JSON-stringified: `console.error(err)`
 * on an `Error` should say what went wrong, not `{}`.
 */
export function installStructuredLogging(): void {
  const levels: Array<[keyof typeof realConsole, LogLine["level"]]> = [
    ["debug", "debug"],
    ["info", "info"],
    ["log", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ]
  for (const [method, level] of levels) {
    console[method] = (...args: unknown[]): void => {
      emit({ ...baseLine(level), message: args.map(format).join(" ") })
    }
  }
}

function format(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // Circular, or a BigInt. Neither is a reason to lose the line.
    return String(value)
  }
}

/**
 * The live tail, as server-sent events.
 *
 * Replays the buffer first so attaching does not start blank, then streams. `retry` is set so a
 * dropped connection reconnects on its own; a tail that silently stops is worse than no tail.
 */
export function tailResponse(): Response {
  const encoder = new TextEncoder()
  let unsubscribe = (): void => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: LogLine): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`))
      }
      controller.enqueue(encoder.encode("retry: 2000\n\n"))
      for (const line of buffer) send(line)

      subscribers.add(send)
      unsubscribe = () => {
        subscribers.delete(send)
      }
    },
    cancel() {
      unsubscribe()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Nothing between here and the reader may buffer a stream whose whole purpose is to arrive as
      // it happens.
      "X-Accel-Buffering": "no",
    },
  })
}

/** For tests: what is currently in the replay buffer. */
export function bufferedLines(): readonly LogLine[] {
  return buffer
}
