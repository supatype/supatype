import React, { useRef } from "react"
import { render, type Instance } from "ink"
import { isInteractive } from "../interactive.js"
import { createClackApi, type ClackApi } from "../clack-api.js"
import { FlowApp } from "../flows/FlowApp.js"
import type { FlowController } from "../flows/types.js"
import { FlowTranscript } from "./flow-transcript.js"
import { prepareStdinForInk, restoreStdinAfterInk } from "./stdin-after-ink.js"

interface RunClackFlowRootProps<T> {
  run: (api: ClackApi) => Promise<T>
  ending: FlowEnding
  /** Handed the run once it has started. */
  onStarted: (outcome: Promise<T>) => void
}

function RunClackFlowRoot<T>({ run, ending, onStarted }: RunClackFlowRootProps<T>): React.ReactElement {
  const started = useRef(false)

  return (
    <FlowApp
      onRelease={ending.inkGone}
      bind={(controller) => {
        if (started.current) return
        started.current = true
        onStarted(run(createClackApi(ending.bind(controller))))
      }}
    />
  )
}

/** The terminal a flow draws on. */
export interface FlowTerminal {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
}

/**
 * How long Ink takes to write a frame it has committed. It holds a redraw back for up to 32 ms, then
 * writes it a tick later; a frame still held when Ink stops is written after whatever came next.
 */
const FRAME_SETTLE_MS = 64

/** Mount a single Ink flow session (init wizard, standalone confirm, etc.). */
export async function runClackFlow<T>(run: (api: ClackApi) => Promise<T>): Promise<T> {
  if (!isInteractive()) {
    throw new Error("Interactive Ink flow requires a TTY.")
  }
  return mountFlowOn(run, { stdin: process.stdin, stdout: process.stdout })
}

/** {@link runClackFlow} on a given terminal. */
export function mountFlowOn<T>(run: (api: ClackApi) => Promise<T>, terminal: FlowTerminal): Promise<T> {
  prepareStdinForInk(terminal.stdin)
  const output = closableOutput(terminal.stdout)
  return new Promise<T>((resolve, reject) => {
    const ending = new FlowEnding(output, terminal)
    const end = (settle: () => void): void => {
      void ending.end().then(settle, settle)
    }
    const instance = render(
      <RunClackFlowRoot
        run={run}
        ending={ending}
        onStarted={(outcome) => {
          outcome.then((value) => end(() => resolve(value)), (err: unknown) => end(() => reject(err)))
        }}
      />,
      // A Ctrl+C is the command's own, not Ink's to end the process on (prompt-interrupt.ts).
      { stdin: terminal.stdin, stdout: output.stream, patchConsole: false, exitOnCtrlC: false },
    )
    ending.attach(instance)
  })
}

/** How a flow comes down: once, either when its command is done or when it calls `process.exit`. */
class FlowEnding {
  private instance: Instance | undefined
  private controller: FlowController | undefined
  private inkExited: Promise<void> = Promise.resolve()
  private restoreExit: () => void = () => undefined
  private ended = false
  /** What the log pane shows, written out if the command exits before Ink can draw it. */
  private readonly transcript = new FlowTranscript()
  private inkAlive = true

  constructor(
    private readonly output: ClosableOutput,
    private readonly terminal: FlowTerminal,
  ) {}

  attach(instance: Instance): void {
    this.instance = instance
    // Ink ends on its own when a prompt takes Ctrl+C; nothing is left to finish then.
    this.inkExited = instance.waitUntilExit().catch(() => undefined)
    this.restoreExit = drawBeforeExit(() => this.atExit())
  }

  /** The controller the flow runs on: `controller`, with what its log pane shows recorded. */
  bind(controller: FlowController): FlowController {
    this.controller = this.transcript.record(controller)
    return this.controller
  }

  /** A Ctrl+C is ending Ink, and the process with it: Ink's last frame stays as it is. */
  readonly inkGone = (): void => {
    this.inkAlive = false
  }

  /** Leave the log lines as the last frame, give Ink time to write it, then stop Ink. */
  async end(): Promise<void> {
    this.restoreExit()
    if (this.ended || this.instance === undefined) return
    this.ended = true
    if (this.inkAlive && this.controller !== undefined) {
      await Promise.race([this.controller.finish(), this.inkExited])
      await new Promise((settled) => setTimeout(settled, FRAME_SETTLE_MS))
    }
    stopInk(this.instance, this.output, this.terminal)
  }

  private atExit(): void {
    if (this.ended || !this.inkAlive || this.instance === undefined) return
    this.ended = true
    endAtExit(this.instance, this.output, this.transcript.text(), this.terminal)
  }
}

/** Ink unmounted, with nothing more of its own written, and stdin given back. */
function stopInk(instance: Instance, output: ClosableOutput, terminal: FlowTerminal): void {
  instance.unmount()
  output.close()
  instance.cleanup()
  restoreStdinAfterInk(terminal.stdin)
}

/**
 * The flow's end when the command calls `process.exit` inside it, which leaves no time for Ink to
 * write the frame it holds (issue 77: `types check` lost its reason). What Ink did write comes off,
 * Ink is silenced, and the lines the pane would have shown go out at once.
 */
function endAtExit(instance: Instance, output: ClosableOutput, shown: string, terminal: FlowTerminal): void {
  try {
    instance.clear()
  } catch {
    // ignore: terminal may already be reset
  }
  output.close()
  restoreStdinAfterInk(terminal.stdin)
  if (shown !== "") terminal.stdout.write(shown)
}

/**
 * Run `draw` when `process.exit` is called, before the process goes; the returned function puts
 * `process.exit` back.
 */
function drawBeforeExit(draw: () => void): () => void {
  const exit = process.exit
  process.exit = (code) => {
    draw()
    return exit.call(process, code)
  }
  return () => {
    process.exit = exit
  }
}

interface ClosableOutput {
  stream: NodeJS.WriteStream
  /** Drop every later write, so a frame Ink still holds cannot be drawn under the last one. */
  close(): void
}

/** `stdout` as Ink is handed it: the same stream, until closed. */
function closableOutput(stdout: NodeJS.WriteStream): ClosableOutput {
  let closed = false
  const stream = new Proxy(stdout, {
    get(target, key) {
      if (key === "write") {
        return (...args: unknown[]): unknown => {
          if (closed) return true
          const written: unknown = Reflect.apply(target.write, target, args)
          return written
        }
      }
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      const bound: unknown = value.bind(target)
      return bound
    },
  })
  return {
    stream,
    close: () => {
      closed = true
    },
  }
}

export { CLACK_CANCEL } from "./cancel.js"
