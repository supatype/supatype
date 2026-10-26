import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import {
  shouldExcludeCommandChrome,
  wrapProgramActionsWithChrome,
} from "../src/ui/runtime/command-chrome.js"

describe("shouldExcludeCommandChrome", () => {
  it("excludes wizard and streaming commands", () => {
    expect(shouldExcludeCommandChrome("dev")).toBe(true)
    expect(shouldExcludeCommandChrome("init")).toBe(true)
    expect(shouldExcludeCommandChrome("link")).toBe(true)
    expect(shouldExcludeCommandChrome("_postinstall")).toBe(true)
    expect(shouldExcludeCommandChrome("add domain")).toBe(true)
    expect(shouldExcludeCommandChrome("logs")).toBe(true)
    expect(shouldExcludeCommandChrome("pg psql")).toBe(true)
    expect(shouldExcludeCommandChrome("functions serve")).toBe(true)
    expect(shouldExcludeCommandChrome("self-host compose logs")).toBe(true)
  })

  it("includes one-shot commands", () => {
    expect(shouldExcludeCommandChrome("push")).toBe(false)
    expect(shouldExcludeCommandChrome("doctor")).toBe(false)
    expect(shouldExcludeCommandChrome("cache rest list")).toBe(false)
    expect(shouldExcludeCommandChrome("deploy rollback")).toBe(false)
  })
})

/** The handler commander runs for a subcommand: its private `_actionHandler`, which wrapping replaces. */
function actionHandler(program: Command, name: string): unknown {
  const cmd = program.commands.find((c) => c.name() === name)
  if (cmd === undefined || !("_actionHandler" in cmd)) throw new Error(`no action handler on ${name}`)
  return cmd._actionHandler
}

describe("wrapProgramActionsWithChrome", () => {
  it("wraps leaf actions but skips excluded paths", () => {
    const program = new Command()
    const pushFn = vi.fn()
    const devFn = vi.fn()

    program.command("push").action(pushFn)
    program.command("dev").action(devFn)

    const pushHandlerBefore = actionHandler(program, "push")
    const devHandlerBefore = actionHandler(program, "dev")
    expect(pushHandlerBefore).toBeTypeOf("function")

    wrapProgramActionsWithChrome(program)

    expect(actionHandler(program, "push")).not.toBe(pushHandlerBefore)
    expect(actionHandler(program, "dev")).toBe(devHandlerBefore)
  })
})
