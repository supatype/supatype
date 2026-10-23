import React from "react"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { render } from "ink"
import { FlowApp } from "../src/ui/flows/FlowApp.js"
import type { FlowController } from "../src/ui/flows/types.js"

/**
 * Fresh-user test B1: init's gateway port prompt dropped the first key typed (18700 saved 8700).
 * Between the provider select and the port prompt init does slow work (docker ps, a port scan),
 * with no prompt mounted. Ink then turned raw mode off and back on for the port prompt, and on
 * Windows the console swallows the first keystroke after that switch. The flow now holds raw
 * mode for its whole life, so no prompt in a flow starts after a mode switch.
 */

/** A stand-in terminal input: a stream that records every raw mode switch Ink asks for. */
function fakeStdin(): PassThrough & { isTTY: true; rawModes: boolean[] } {
  const rawModes: boolean[] = []
  return Object.assign(new PassThrough(), {
    isTTY: true as const,
    rawModes,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode)
    },
    ref: () => undefined,
    unref: () => undefined,
  })
}

type FakeStdin = ReturnType<typeof fakeStdin>

/** Ink reads a terminal through these members; the fakes have them, checked rather than cast. */
function isTtyInput(stream: object): stream is NodeJS.ReadStream {
  return "setRawMode" in stream && "isTTY" in stream
}

function isTtyOutput(stream: object): stream is NodeJS.WriteStream {
  return "columns" in stream && "write" in stream
}

function mountFlow(stdin: FakeStdin): Promise<{ controller: FlowController; unmount: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true })
  if (!isTtyInput(stdin) || !isTtyOutput(stdout)) throw new Error("fake streams lack terminal members")
  return new Promise((resolve) => {
    const bind = (controller: FlowController): void => resolve({ controller, unmount: () => instance.unmount() })
    const instance = render(React.createElement(FlowApp, { bind }), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  })
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function typeKeys(stdin: FakeStdin, keys: string): Promise<void> {
  for (const key of keys) {
    stdin.write(key)
    await tick(15)
  }
}

describe("init flow raw mode", () => {
  it("keeps raw mode on between prompts, so the next prompt's first key is not lost", async () => {
    const stdin = fakeStdin()
    const { controller, unmount } = await mountFlow(stdin)
    const provider = controller.waitForPrompt({
      kind: "select",
      message: "How should Postgres and the server run for local development?",
      options: [{ value: "docker", label: "Docker" }],
    })
    await tick(30)
    await typeKeys(stdin, "\r")
    expect(await provider).toBe("docker")

    // init's docker and port scan run here, with no prompt mounted.
    await tick(50)
    expect(stdin.rawModes).not.toContain(false)

    const port = controller.waitForPrompt({ kind: "text", message: "Local API gateway port (Kong)", defaultValue: "18478" })
    await tick(30)
    await typeKeys(stdin, "18700\r")
    expect(await port).toBe("18700")
    unmount()
  })
})
