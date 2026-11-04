import { PassThrough } from "node:stream"

/** A terminal pair for rendering Ink in a test: keys go in on `stdin`, frames collect in `drawn()`. */
export interface FakeTty {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  /** Everything drawn since the last `clear()`. */
  drawn(): string
  /** The same, as Ink wrote it: one chunk per write, so the last one holding a frame is that frame. */
  chunks(): readonly string[]
  clear(): void
}

function isTtyInput(stream: object): stream is NodeJS.ReadStream {
  return "setRawMode" in stream && "isTTY" in stream
}

function isTtyOutput(stream: object): stream is NodeJS.WriteStream {
  return "columns" in stream && "write" in stream
}

/** A wait long enough for Ink to draw what a test just changed: it holds redraws back a little. */
export function tick(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Streams with the members Ink reads of a terminal, and nothing behind them. */
export function fakeTty(columns: number, rows: number): FakeTty {
  let chunks: string[] = []
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true })
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  })
  if (!isTtyInput(stdin) || !isTtyOutput(stdout)) throw new Error("fake streams lack terminal members")
  return {
    stdin,
    stdout,
    drawn: () => chunks.join(""),
    chunks: () => chunks,
    clear: () => {
      chunks = []
    },
  }
}
