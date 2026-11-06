import type { ChildProcess, ExecFileOptions } from "node:child_process"
import { Writable } from "node:stream"

/** What a faked command answered, in the terms `spawnSync` reports a run in. */
export interface FakeRun {
  status: number | null
  stdout?: string
  stderr?: string
  /** Why it could not start; reported as an `ENOENT` spawn error. */
  error?: string
}

/** A faked run's options, with what the caller wrote to its stdin, as `spawnSync`'s `input` was. */
export type FakeRunOptions = ExecFileOptions & { input?: string }

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

/** Answers a faked command; may take its time, as a real one does. */
export type FakeAnswer = (cmd: string, args: readonly string[], opts: FakeRunOptions) => FakeRun | Promise<FakeRun>

function isCallback(value: unknown): value is ExecFileCallback {
  return typeof value === "function"
}

function isOptions(value: unknown): value is ExecFileOptions {
  return typeof value === "object" && value !== null
}

/** The error `execFile` hands its callback for a run that did not exit 0. */
function execFileError(run: FakeRun): Error | null {
  if (run.error !== undefined) return Object.assign(new Error(run.error), { code: "ENOENT" })
  if (run.status === 0) return null
  return Object.assign(new Error(`Command failed: exit ${run.status ?? "null"}`), { code: run.status })
}

/** A stdin that keeps what is written to it. */
function capturingStdin(): { stdin: Writable; written: () => string } {
  let text = ""
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void) {
      text += chunk.toString()
      done()
    },
  })
  return { stdin, written: () => text }
}

/**
 * An `execFile` for `vi.mock("node:child_process")`: `answer` says what each command answered, and
 * the callback hears it as `execFile` would report that run. The answer comes a tick after the call,
 * once the caller has written the run's stdin. Types only are imported from the module: the mock
 * factory hands over the real `ChildProcess`, since importing the module being mocked from inside
 * its own factory never settles.
 */
export function fakeExecFile(answer: FakeAnswer, newChild: () => ChildProcess) {
  return (cmd: string, args: readonly string[], ...rest: unknown[]): ChildProcess => {
    const callback = rest.find(isCallback)
    const opts = rest.find(isOptions) ?? {}
    const child = newChild()
    const { stdin, written } = capturingStdin()
    child.stdin = stdin
    setImmediate(() => {
      const input = written()
      void Promise.resolve(answer(cmd, args, { ...opts, ...(input !== "" && { input }) })).then((run) => {
        callback?.(execFileError(run), run.stdout ?? "", run.stderr ?? "")
      })
    })
    return child
  }
}
