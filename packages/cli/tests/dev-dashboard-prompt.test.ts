import React from "react"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { render } from "ink"
import { DevDashboard } from "../src/ui/dev/DevDashboard.js"
import { DevLogBus } from "../src/dev-log-bus.js"
import { enqueueDevPrompt, resetDevPromptQueueForTests } from "../src/ui/runtime/dev-prompt-queue.js"

/**
 * The dev dashboard has a fixed height and used to set aside six rows for any prompt. A prompt
 * taller than that was squeezed to fit, and its last line was drawn over the line above it: the
 * leftover-stack question showed as `Yes / No: y/n, ←/→, enterefore starting?`.
 */

const LEFTOVER_STACK_QUESTION =
  'Previous dev session for "fresh-cms" may not have shut down cleanly (stack "supatype-fresh-cms" is still running).' +
  "\n\nStop the orphaned stack before starting?"

function isTtyInput(stream: object): stream is NodeJS.ReadStream {
  return "setRawMode" in stream && "isTTY" in stream
}

function isTtyOutput(stream: object): stream is NodeJS.WriteStream {
  return "columns" in stream && "write" in stream
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Render the dashboard on a fake terminal and return the last frame, without escape codes. */
async function lastFrame(columns: number, rows: number): Promise<string> {
  const chunks: string[] = []
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true })
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  })
  if (!isTtyInput(stdin) || !isTtyOutput(stdout)) throw new Error("fake streams lack terminal members")
  const instance = render(React.createElement(DevDashboard, { bus: new DevLogBus() }), {
    stdin,
    stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await tick(100)
  instance.unmount()
  const frames = chunks.filter((chunk) => chunk.includes("╭"))
  // eslint-disable-next-line no-control-regex
  return (frames[frames.length - 1] ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** The text rows inside the prompt panel's border, trimmed. */
function panelRows(frame: string): string[] {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.includes("╭"))
  const bottom = lines.findIndex((line) => line.includes("╰"))
  return lines.slice(top + 1, bottom).map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trim())
}

describe("dev dashboard prompt panel", () => {
  afterEach(() => resetDevPromptQueueForTests())

  for (const columns of [140, 80]) {
    it(`shows every line of a tall confirm prompt, with the key hint on its own line (${columns} columns)`, async () => {
      void enqueueDevPrompt({ kind: "confirm", message: LEFTOVER_STACK_QUESTION, initialValue: true })
      const rows = panelRows(await lastFrame(columns, 30))
      expect(rows).toContain("Stop the orphaned stack before starting?")
      expect(rows).toContain("Yes / No: y/n, ←/→, enter")
      expect(rows.join(" ")).toContain("is still running).")
    })
  }

  it("takes the prompt's rows from the log, not from the rest of the dashboard", async () => {
    void enqueueDevPrompt({ kind: "confirm", message: LEFTOVER_STACK_QUESTION, initialValue: true })
    const lines = (await lastFrame(80, 30)).replace(/\n$/, "").split("\n")
    expect(lines.length).toBeLessThanOrEqual(30)
    // The logo's top row is the first thing squeezed out when the prompt is under-counted.
    expect(lines[0]?.trim()).toBe("__")
  })
})
