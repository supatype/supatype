import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"

/**
 * `--no-cache` on `adopt` and `doctor` does nothing now the database is always read live. A script
 * that passes it must keep working, be told, and not see the flag offered in help.
 */

const warned: string[] = []
vi.mock("../src/ui/messages.js", () => ({ warn: (line: string) => warned.push(line) }))

const { addRetiredNoCacheOption, warnIfRetiredNoCache } = await import("../src/retired-no-cache.js")

function parse(args: string[]): { cache?: boolean } {
  const program = new Command().exitOverride()
  let seen: { cache?: boolean } = {}
  addRetiredNoCacheOption(program.command("adopt")).action((opts: { cache?: boolean }) => {
    seen = opts
  })
  program.parse(["node", "supatype", "adopt", ...args])
  return seen
}

describe("the retired --no-cache flag", () => {
  it("is still accepted, so a script passing it does not break", () => {
    expect(() => parse(["--no-cache"])).not.toThrow()
  })

  it("says it is no longer needed, read the way Commander stores it", () => {
    warned.length = 0
    warnIfRetiredNoCache(parse(["--no-cache"]))
    expect(warned.join("\n")).toContain("--no-cache is no longer needed")
  })

  it("says nothing when it was not passed", () => {
    warned.length = 0
    warnIfRetiredNoCache(parse([]))
    expect(warned).toEqual([])
  })

  it("is not offered in help", () => {
    const program = new Command()
    const adopt = addRetiredNoCacheOption(program.command("adopt"))
    expect(adopt.helpInformation()).not.toContain("--no-cache")
  })
})
