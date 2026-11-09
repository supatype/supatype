import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { render, type Instance } from "ink"
import { FlowApp } from "../src/ui/flows/FlowApp.js"
import type { FlowController } from "../src/ui/flows/types.js"
import { editLine, type LineKey } from "../src/ui/components/LineInput.js"
import { fakeTty, tick, type FakeTty } from "./support/fake-tty.js"

/**
 * Issue 78: Ink hands a burst of keys to a prompt as one string, as a paste ending in a line break
 * sends them. The text prompt put the whole string in the field: the `\r` was kept and drawn raw,
 * Enter did not submit, and backspaces in a burst went in as characters too.
 */

const NO_KEY: LineKey = {
  return: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  backspace: false,
  delete: false,
  tab: false,
  escape: false,
  ctrl: false,
}

let mounted: Instance | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

function mountFlow(tty: FakeTty): Promise<FlowController> {
  return new Promise((resolve) => {
    mounted = render(React.createElement(FlowApp, { bind: resolve }), {
      stdin: tty.stdin,
      stdout: tty.stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
  })
}

/** What the text prompt answers after `bursts` arrive, each in one read; "unanswered" if it does not. */
async function answerAfter(bursts: string[], validate?: (value: string) => string | undefined): Promise<unknown> {
  const tty = fakeTty(100, 40)
  const controller = await mountFlow(tty)
  const answer = controller.waitForPrompt({ kind: "text", message: "Admin email", ...(validate !== undefined && { validate }) })
  await tick(50)
  for (const burst of bursts) {
    tty.stdin.write(burst)
    await tick(50)
  }
  return Promise.race([answer, tick(200).then(() => "unanswered")])
}

describe("a text prompt given a burst of keys", () => {
  it("submits on a line break at the end of a paste, without keeping it", async () => {
    expect(await answerAfter(["admin@e2ewin.dev\r"])).toBe("admin@e2ewin.dev")
    expect(await answerAfter(["admin@e2ewin.dev\r\n"])).toBe("admin@e2ewin.dev")
  })

  it("erases for each backspace in a burst", async () => {
    expect(await answerAfter(["admin@x.devvv", "\x7f\x7f", "\r"])).toBe("admin@x.dev")
    expect(await answerAfter(["admin@x.devvv\b\b\r"])).toBe("admin@x.dev")
  })

  it("still submits typed keys one at a time", async () => {
    expect(await answerAfter([..."a@b.co", "\r"])).toBe("a@b.co")
  })
})

describe("editLine", () => {
  it("inserts at the cursor and moves it", () => {
    expect(editLine({ value: "ac", cursor: 1 }, "b", NO_KEY)).toEqual({ value: "abc", cursor: 2, submit: false })
  })

  it("ignores what follows the first line break", () => {
    expect(editLine({ value: "", cursor: 0 }, "one\rtwo", NO_KEY)).toEqual({ value: "one", cursor: 3, submit: true })
  })

  it("does not erase past the start", () => {
    expect(editLine({ value: "a", cursor: 1 }, "\x7f\x7f\x7f", NO_KEY)).toEqual({ value: "", cursor: 0, submit: false })
  })
})
