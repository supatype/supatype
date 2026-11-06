import { afterEach, describe, expect, it } from "vitest"
import { DevLogBus } from "../src/dev-log-bus.js"
import { renderDevDashboard } from "../src/dev-session.js"
import { enqueueDevPrompt, resetDevPromptQueueForTests } from "../src/ui/runtime/dev-prompt-queue.js"
import { fakeTty, tick } from "./support/fake-tty.js"

/**
 * The dev dashboard has a fixed height and used to set aside six rows for any prompt. A prompt
 * taller than that was squeezed to fit, and its last line was drawn over the line above it: the
 * leftover-stack question showed as `Yes / No: y/n, ←/→, enterefore starting?`.
 */

const LEFTOVER_STACK_QUESTION =
  'Previous dev session for "fresh-cms" may not have shut down cleanly (stack "supatype-fresh-cms" is still running).' +
  "\n\nStop the orphaned stack before starting?"

/** Render the dashboard on a fake terminal and return the last frame, without escape codes. */
async function lastFrame(columns: number, rows: number): Promise<string> {
  const { stdin, stdout, chunks } = fakeTty(columns, rows)
  const instance = renderDevDashboard(new DevLogBus(), { stdin, stdout, patchConsole: false })
  await tick(100)
  instance.unmount()
  const frames = chunks().filter((chunk) => chunk.includes("╭"))
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
      expect(rows).toContain("Yes / No: Y/n, ←/→, enter for yes")
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
