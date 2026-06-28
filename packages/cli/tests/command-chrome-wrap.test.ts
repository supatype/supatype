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

describe("wrapProgramActionsWithChrome", () => {
  it("wraps leaf actions but skips excluded paths", () => {
    const program = new Command()
    const pushFn = vi.fn()
    const devFn = vi.fn()

    program.command("push").action(pushFn)
    program.command("dev").action(devFn)

    type CommandWithAction = Command & {
      _actionHandler?: ((args: unknown) => unknown) | null
    }

    const pushCmd = program.commands.find((c) => c.name() === "push") as CommandWithAction
    const devCmd = program.commands.find((c) => c.name() === "dev") as CommandWithAction
    const pushHandlerBefore = pushCmd._actionHandler
    const devHandlerBefore = devCmd._actionHandler

    wrapProgramActionsWithChrome(program)

    expect(pushCmd._actionHandler).not.toBe(pushHandlerBefore)
    expect(devCmd._actionHandler).toBe(devHandlerBefore)
  })
})
