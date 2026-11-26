/**
 * init's setup steps (install, keys, binaries), run without blocking and shown as they run.
 *
 * The install ran through `spawnSync` with inherited output, which blocked the event loop for the
 * whole install: the interactive spinner froze, and the Docker probe's 5 s timer fired before
 * Docker's answer could be read, so every init with install said the daemon was not running while
 * it was (local test round 3, N6). It now runs through `spawn`. In a terminal the spinner keeps
 * moving, reads `Installing dependencies with npm... 14s` and shows the package manager's latest
 * line under it. Without one, each step prints a start line and a done line with its time, and the
 * package manager's output passes through as before (D1).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { stripAnsi } from "./dev-log-filter.js"
import { errorMessage, redactSecrets } from "./error-message.js"
import type { ClackSpinner } from "./ui/clack-api.js"

/** How to run a package manager's install. */
export interface InstallCommand {
  file: string
  args: readonly string[]
  shell: boolean
}

/** `<pm> install`, through a shell on Windows, where package managers are `.cmd` files. */
export function installCommand(pm: string): InstallCommand {
  return { file: pm, args: ["install"], shell: process.platform === "win32" }
}

/** How many of the package manager's last lines a failed install prints, when its output was read. */
const FAILURE_TAIL_LINES = 20

/** The longest a printed line of that output is, so one minified blob cannot fill the terminal. */
const FAILURE_LINE_CHARS = 300

/** What a failed install can say about itself. */
export interface InstallFailure {
  /** The lifecycle script that was running when it failed (`prepare`, `postinstall`), when the output named one. */
  script?: string
  /** Where that script lives: the package, or its path under node_modules. */
  where?: string
  /** What the script ran, as the package manager printed it. */
  command?: string
  exitCode: number | null
  /** The last lines of the output, with secrets hidden. */
  tail: string[]
  /** Set when the package manager could not be run at all. */
  cause?: string
}

/** The result of {@link installDependencies}. */
export type InstallResult = { ok: true } | { ok: false; failure: InstallFailure }

/** The lifecycle script a package manager's output says is running or has failed, as far as it has said. */
interface ScriptMark {
  script: string
  where?: string
  command?: string
}

/** npm 7+ prints `> pkg@1.0.0 prepare` and then `> <command>` as a script starts. */
const NPM_SCRIPT_HEADER = /^> (\S+@\S+)\s+(\S+)$/
const NPM_SCRIPT_COMMAND = /^> (.+)$/
/** pnpm prints `<package path> <script>$ <command>` as a script starts, and `<path> <script>: Failed` when it fails. */
const PNPM_SCRIPT_START = /^(\S+)\s+([\w:.-]+)\$\s+(.+)$/
const PNPM_SCRIPT_FAILED = /^(\S+)\s+([\w:.-]+): Failed$/
/** npm and yarn say what they ran: `npm error command sh -c <command>`, `Command: <command>`. */
const FAILED_COMMAND = /^(?:npm (?:error|ERR!) command sh -c |Command: )(.+)$/

/** Reads a package manager's output line by line and keeps the script it last said was running or failed. */
class ScriptTracker {
  private running: ScriptMark | undefined
  private failed: ScriptMark | undefined

  see(line: string): void {
    const failed = PNPM_SCRIPT_FAILED.exec(line)
    if (failed?.[1] !== undefined && failed[2] !== undefined) {
      const known = this.running?.script === failed[2] ? this.running : undefined
      this.failed = { ...known, script: failed[2], where: failed[1] }
      return
    }
    const pnpm = PNPM_SCRIPT_START.exec(line)
    if (pnpm?.[1] !== undefined && pnpm[2] !== undefined && pnpm[3] !== undefined) {
      this.running = { script: pnpm[2], where: pnpm[1], command: pnpm[3] }
      return
    }
    const header = NPM_SCRIPT_HEADER.exec(line)
    if (header?.[1] !== undefined && header[2] !== undefined) {
      this.running = { script: header[2], where: header[1] }
      return
    }
    const command = NPM_SCRIPT_COMMAND.exec(line)
    if (command?.[1] !== undefined && this.running !== undefined && this.running.command === undefined) {
      this.running = { ...this.running, command: command[1] }
      return
    }
    const ran = FAILED_COMMAND.exec(line)
    if (ran?.[1] !== undefined && this.running !== undefined) this.running = { ...this.running, command: ran[1] }
  }

  /** The script that failed: the one a package manager said failed, else the last one it started. */
  mark(): ScriptMark | undefined {
    return this.failed ?? this.running
  }
}

/** Secret-looking values in a line of output, which must not reach a terminal or a CI log. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /npm_[A-Za-z0-9]{20,}/g,
  /((?:_auth(?:Token)?|_password)=)\S+/gi,
  /(Bearer\s+)\S+/gi,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)S?=)\S+/g,
]

/** One line of output, shortened and with every secret-looking value hidden. */
function safeLine(line: string): string {
  const hidden = SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, (_all: string, keep: string | undefined) => `${typeof keep === "string" ? keep : ""}***`),
    redactSecrets(line, []),
  )
  return hidden.length > FAILURE_LINE_CHARS ? `${hidden.slice(0, FAILURE_LINE_CHARS)}...` : hidden
}

/**
 * Run an install in `dir`, and say how it went. The output is always read, for the failure: with
 * `onLine` each line is handed over as it arrives, and without it the output also passes through to
 * this terminal as the package manager wrote it.
 */
export function installDependencies(
  dir: string,
  command: InstallCommand,
  onLine?: (line: string) => void,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command.file, [...command.args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: command.shell,
    })
    const tail: string[] = []
    const scripts = new ScriptTracker()
    if (onLine === undefined) passThrough(child)
    followLines(child, (line) => {
      scripts.see(line)
      keepTail(tail, safeLine(line))
      onLine?.(line)
    })
    child.once("error", (err) => {
      resolve({ ok: false, failure: { exitCode: null, tail: [], cause: `Could not run ${command.file}: ${errorMessage(err)}` } })
    })
    child.once("close", (code) => {
      if (code === 0) return resolve({ ok: true })
      const mark = scripts.mark()
      resolve({
        ok: false,
        failure: {
          ...(mark?.script !== undefined && { script: mark.script }),
          ...(mark?.where !== undefined && { where: mark.where }),
          ...(mark?.command !== undefined && { command: safeLine(mark.command) }),
          exitCode: code,
          tail,
        },
      })
    })
  })
}

/** Write what the child prints to this process's own streams, as inheriting them would. */
function passThrough(child: ChildProcess): void {
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
}

/**
 * The message for a failed install: what failed, how, the last lines it printed, and what to run.
 * The lines are already bounded and have their secrets hidden ({@link installDependencies}).
 */
export function describeInstallFailure(pm: string, failure: InstallFailure): string {
  const run = `Run "${pm} install" in the project directory, then "supatype update".`
  if (failure.cause !== undefined) return `Dependency install failed. ${failure.cause}. ${run}`
  const script =
    failure.script === undefined
      ? undefined
      : `the "${failure.script}" script${failure.where === undefined ? "" : ` of ${failure.where}`}${failure.command === undefined ? "" : ` (${failure.command})`}`
  const how = failure.exitCode === null ? "was stopped" : `ended with exit code ${failure.exitCode}`
  const lines = failure.tail.length === 0 ? "" : `\nLast lines of its output:\n${failure.tail.map((l) => `  ${l}`).join("\n")}\n`
  return `Dependency install failed: ${script ?? `${pm} install`} ${how}.${lines}${run}`
}

/** Keep `line` among the last {@link FAILURE_TAIL_LINES}. */
function keepTail(tail: string[], line: string): void {
  tail.push(line)
  if (tail.length > FAILURE_TAIL_LINES) tail.shift()
}

/** Each non-blank line a child prints on stdout or stderr, without colour codes. */
function followLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    let partial = ""
    const emit = (raw: string): void => {
      const line = stripAnsi(raw).trim()
      if (line !== "") onLine(line)
    }
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      const lines = `${partial}${chunk}`.split(/\r\n|\r|\n/)
      partial = lines.pop() ?? ""
      lines.forEach(emit)
    })
    stream.on("end", () => emit(partial))
  }
}

/** How a step is shown. A live view is updated as the step runs; a plain one gets two lines. */
export interface StepView {
  live: boolean
  start(text: string): void
  update(text: string): void
  /** `ok: false` shows the line as a failure, not with the success tick. */
  stop(text: string, ok?: boolean): void
}

/** A spinner's view of a step, for a terminal. `start` again replaces the spinner's text. */
export function spinnerStepView(spinner: ClackSpinner): StepView {
  return {
    live: true,
    start: (text) => spinner.start(text),
    update: (text) => spinner.start(text),
    stop: (text, ok) => spinner.stop(text, ok),
  }
}

/** Start and done lines, for output that is not a terminal. */
export function plainStepView(say: (line: string) => void = (line) => console.log(`[supatype] ${line}`)): StepView {
  return { live: false, start: say, update: () => undefined, stop: say }
}

/** One setup step: what it is called, the work, and the line to end it with. */
export interface TimedStep<T> {
  label: string
  run: (detail: (line: string) => void) => Promise<T>
  done: (result: T) => string
}

/** A live step's text: its label, the whole seconds so far, and its latest line under it. */
function liveStepText(label: string, seconds: number, detail: string): string {
  const head = `${label}... ${seconds}s`
  return detail === "" ? head : `${head}\n  ${detail}`
}

/** Seconds since `started`, to one decimal place, for a done line. */
function took(started: number, now: () => number): string {
  return `${((now() - started) / 1000).toFixed(1)}s`
}

/**
 * Run `step`, showing it on `view` with the time it takes. A live view is redrawn every second,
 * with the latest output line kept until then: one redraw per line flooded the terminal.
 */
export async function runTimedStep<T>(view: StepView, step: TimedStep<T>, now: () => number = Date.now): Promise<T> {
  const started = now()
  let detail = ""
  const redraw = (): void => view.update(liveStepText(step.label, Math.floor((now() - started) / 1000), detail))
  view.start(`${step.label}...`)
  const timer = view.live ? setInterval(redraw, 1_000) : undefined
  try {
    const result = await step.run((line) => {
      detail = line
    })
    // A step that answers false did not succeed: its done line must not wear the success tick (S-20).
    view.stop(`${step.done(result)} (${took(started, now)})`, result !== false)
    return result
  } catch (err) {
    view.stop(`${step.label} failed (${took(started, now)})`, false)
    throw err
  } finally {
    if (timer !== undefined) clearInterval(timer)
  }
}
