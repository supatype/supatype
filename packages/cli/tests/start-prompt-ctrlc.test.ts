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

function fakeStdin(): PassThrough & { isTTY: true } {
  return Object.assign(new PassThrough(), { isTTY: true as const, setRawMode: () => undefined, ref: () => undefined, unref: () => undefined })
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

const added: Array<{ signal: NodeJS.Signals; listener: (...args: unknown[]) => void }> = []

/** Removes the signal listeners the test added, dev's hooks among them. */
function removeAddedListeners(before: Map<NodeJS.Signals, readonly unknown[]>): void {
  for (const signal of STOP_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!(before.get(signal) ?? []).includes(listener)) process.removeListener(signal, listener)
    }
  }
  added.length = 0
}

afterEach(() => {
  vi.restoreAllMocks()
  resetDevShutdownForTests()
})

describe("Ctrl+C on a prompt", () => {
  it("is mounted so that Ink does not end the process on it", () => {
    const source = readFileSync(new URL("../src/ui/runtime/run-clack-flow.tsx", import.meta.url), "utf8")
    expect(source).toMatch(/exitOnCtrlC: false/)
  })

  it("is heard as the command's own Ctrl+C", async () => {
    const heard: string[] = []
    const listener = (): void => void heard.push("SIGINT")
    process.on("SIGINT", listener)
    const stdin = fakeStdin()
    const { controller, unmount } = await mountFlow(stdin)
    try {
      void controller.waitForPrompt({ kind: "confirm", message: "Save port 54339 to .env?", initialValue: false })
      await tick(30)
      stdin.write("\x03")
      await tick(30)
      expect(heard).toEqual(["SIGINT"])
    } finally {
      unmount()
      process.removeListener("SIGINT", listener)
    }
  })

  it("during dev's start stops what the start began, waits for it, says so and exits 130", async () => {
    const before = new Map(STOP_SIGNALS.map((signal) => [signal, [...process.listeners(signal)]] as const))
    const said: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      said.push(String(chunk))
      return true
    })
    let postgresStopped = false
    const exited = new Promise<number | undefined>((resolve) => {
      // Recorded and left there: the process goes on, as nothing after the exit in dev runs. A throw
      // would land in the shutdown's own catch, which exits again, unhandled.
      function recordExit(code?: string | number | null): never
      function recordExit(code?: string | number | null): void {
        resolve(code === null || code === undefined ? undefined : Number(code))
      }
      vi.spyOn(process, "exit").mockImplementation(recordExit)
    })
    ensureDevShutdownHooks()
    pushStartUndoLast(async () => {
      await tick(100)
      postgresStopped = true
    })
    const stdin = fakeStdin()
    const { controller, unmount } = await mountFlow(stdin)
    try {
      void controller.waitForPrompt({ kind: "confirm", message: "Save port 54339 to .env?", initialValue: false })
      await tick(30)
      stdin.write("\x03")
      expect(await exited).toBe(130)
      expect(postgresStopped).toBe(true)
      expect(said.join("")).toContain("Stopped during start.")
    } finally {
      unmount()
      removeAddedListeners(before)
    }
  })
})
