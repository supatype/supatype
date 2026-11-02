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
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { stripAnsi } from "./dev-log-filter.js"
import { errorMessage } from "./error-message.js"
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

/**
 * Run an install in `dir`, true when it succeeds. With `onLine`, its output is read, each line handed
 * over, and the last lines printed if it fails; without, its output passes through to this terminal.
 */
export function installDependencies(
  dir: string,
  command: InstallCommand,
  onLine?: (line: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const stdio: StdioOptions = onLine === undefined ? "inherit" : ["ignore", "pipe", "pipe"]
    const child: ChildProcess = spawn(command.file, [...command.args], { cwd: dir, stdio, shell: command.shell })
    const tail: string[] = []
    if (onLine !== undefined) followLines(child, (line) => keepTail(tail, line, onLine))
    child.once("error", (err) => {
      console.error(`Could not run ${command.file}: ${errorMessage(err)}`)
      resolve(false)
    })
    child.once("close", (code) => {
      if (code !== 0 && tail.length > 0) console.error(tail.join("\n"))
      resolve(code === 0)
    })
  })
}

/** Keep `line` among the last {@link FAILURE_TAIL_LINES}, and hand it on. */
function keepTail(tail: string[], line: string, onLine: (line: string) => void): void {
  tail.push(line)
  if (tail.length > FAILURE_TAIL_LINES) tail.shift()
  onLine(line)
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
  stop(text: string): void
}

/** A spinner's view of a step, for a terminal. `start` again replaces the spinner's text. */
export function spinnerStepView(spinner: ClackSpinner): StepView {
  return {
    live: true,
    start: (text) => spinner.start(text),
    update: (text) => spinner.start(text),
    stop: (text) => spinner.stop(text),
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
    view.stop(`${step.done(result)} (${took(started, now)})`)
    return result
  } catch (err) {
    view.stop(`${step.label} failed (${took(started, now)})`)
    throw err
  } finally {
    if (timer !== undefined) clearInterval(timer)
  }
}
