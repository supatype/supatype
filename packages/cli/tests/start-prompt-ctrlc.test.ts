import React from "react"
import { PassThrough } from "node:stream"
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "ink"
import { FlowApp } from "../src/ui/flows/FlowApp.js"
import type { FlowController } from "../src/ui/flows/types.js"
import { ensureDevShutdownHooks, pushStartUndoLast, resetDevShutdownForTests } from "../src/dev-shutdown.js"
import { STOP_SIGNALS } from "../src/stop-signals.js"

/**
 * Local test round 7, N32: a Ctrl+C on the "Save port ... to .env?" prompt during native start
 * exited 0 with no "Stopped during start." and cut Postgres off mid shutdown, leaving a stale
 * postmaster.pid. A prompt holds the terminal in raw mode, so the Ctrl+C reached the prompt as a key
 * and Ink ended the process, rather than reaching dev as the signal its start-time stop listens for.
 * A Ctrl+C on any prompt is now the command's own Ctrl+C.
 */

function fakeStdin(): PassThrough & { isTTY: true; rawModes: boolean[] } {
  const rawModes: boolean[] = []
  return Object.assign(new PassThrough(), {
    isTTY: true as const,
    rawModes,
    setRawMode: (mode: boolean) => void rawModes.push(mode),
    ref: () => undefined,
    unref: () => undefined,
  })
}

function isTtyInput(stream: object): stream is NodeJS.ReadStream {
  return "setRawMode" in stream && "isTTY" in stream
}

function isTtyOutput(stream: object): stream is NodeJS.WriteStream {
  return "columns" in stream && "write" in stream
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The flow as `runClackFlow` mounts it, with its options, so what it does with Ctrl+C is what runs. */
function mountFlow(stdin: PassThrough): Promise<{ controller: FlowController; unmount: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true })
  if (!isTtyInput(stdin) || !isTtyOutput(stdout)) throw new Error("fake streams lack terminal members")
  return new Promise((resolve) => {
    const bind = (controller: FlowController): void => resolve({ controller, unmount: () => instance.unmount() })
    const instance = render(React.createElement(FlowApp, { bind }), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  })
}

/**
 * `process.exit`, recorded and left there: the process goes on, as nothing after the exit runs in
 * the code under test. A throw would land in the shutdown's own catch, which exits again, unhandled.
 */
function recordExits(): { codes: number[]; first: Promise<number> } {
  const codes: number[] = []
  const first = new Promise<number>((resolve) => {
    function recordExit(code?: string | number | null): never
    function recordExit(code?: string | number | null): void {
      codes.push(Number(code ?? 0))
      resolve(Number(code ?? 0))
    }
    vi.spyOn(process, "exit").mockImplementation(recordExit)
  })
  return { codes, first }
}

/** What the test writes to stderr, captured. */
function captureStderr(): string[] {
  const said: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    said.push(String(chunk))
    return true
  })
  return said
}

let before = new Map<NodeJS.Signals, readonly unknown[]>()

/** Removes the signal listeners a test added, dev's hooks among them. */
function removeAddedListeners(): void {
  for (const signal of STOP_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!(before.get(signal) ?? []).includes(listener)) process.removeListener(signal, listener)
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  resetDevShutdownForTests()
  removeAddedListeners()
})

/** A flow showing dev's "Save port" prompt, and Ctrl+C typed into it. */
async function ctrlCOnPrompt(stdin: ReturnType<typeof fakeStdin>): Promise<() => void> {
  before = new Map(STOP_SIGNALS.map((signal) => [signal, [...process.listeners(signal)]] as const))
  const { controller, unmount } = await mountFlow(stdin)
  void controller.waitForPrompt({ kind: "confirm", message: "Save port 54339 to .env?", initialValue: false })
  await tick(30)
  stdin.write("\x03")
  return unmount
}

describe("Ctrl+C on a prompt", () => {
  it("is mounted so that Ink does not end the process on it", () => {
    const source = readFileSync(new URL("../src/ui/runtime/run-clack-flow.tsx", import.meta.url), "utf8")
    expect(source).toMatch(/exitOnCtrlC: false/)
  })

  it("during dev's start stops what the start began, waits for it, says so and exits 130", async () => {
    const said = captureStderr()
    const exits = recordExits()
    ensureDevShutdownHooks()
    let postgresStopped = false
    pushStartUndoLast(async () => {
      await tick(100)
      postgresStopped = true
    })
    const unmount = await ctrlCOnPrompt(fakeStdin())
    try {
      expect(await exits.first).toBe(130)
      expect(postgresStopped).toBe(true)
      expect(said.join("")).toContain("Stopped during start.")
    } finally {
      unmount()
    }
  })

  // Review of round 7: on Windows a real SIGINT can arrive beside the key. Taken as a second Ctrl+C,
  // it force-quit the shutdown and cut Postgres off after all.
  it("is not taken twice when the terminal also sends SIGINT", async () => {
    const said = captureStderr()
    const exits = recordExits()
    ensureDevShutdownHooks()
    let postgresStopped = false
    pushStartUndoLast(async () => {
      await tick(200)
      postgresStopped = true
    })
    const unmount = await ctrlCOnPrompt(fakeStdin())
    try {
      await tick(20)
      process.emit("SIGINT", "SIGINT")
      expect(await exits.first).toBe(130)
      expect(postgresStopped).toBe(true)
      expect(said.join("")).not.toContain("Forced quit")
    } finally {
      unmount()
    }
  })

  // Review of round 7: any SIGINT listener was taken for the CLI's own shutdown. One that does not
  // end the process (signal-exit, a child's forwarding) left the prompt pending, in raw mode, forever.
  it("with no shutdown of the CLI's own, ends the command with 130 and gives the terminal back", async () => {
    const heard: string[] = []
    const foreign = (): void => void heard.push("SIGINT")
    process.on("SIGINT", foreign)
    const exits = recordExits()
    const stdin = fakeStdin()
    const unmount = await ctrlCOnPrompt(stdin)
    try {
      expect(await exits.first).toBe(130)
      expect(heard).toEqual([])
      expect(stdin.rawModes.at(-1)).toBe(false)
    } finally {
      unmount()
      process.removeListener("SIGINT", foreign)
    }
  })
})
