import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 0.9.2 release test round 5 (S-6): on Windows, another process holding hooks.ts open without
 * delete sharing made the rename onto it fail, and push exited 1 with a raw
 * `EPERM: operation not permitted, rename`, leaving two `.tmp` files behind. Writing in place
 * succeeds under the same hold, so a held file is written in place.
 */
const rename = vi.hoisted(() => ({ fail: undefined as string | undefined }))
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (rename.fail === undefined) return real.renameSync(from, to)
      throw Object.assign(new Error(`${rename.fail}: rename '${from}' -> '${to}'`), { code: rename.fail })
    },
  }
})

const { writeIfChanged } = await import("../src/write-if-changed.js")

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-write-if-changed-"))
  rename.fail = undefined
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("writeIfChanged", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("writes a file held open in place when the rename fails with %s", (code) => {
    const path = join(dir, "hooks.ts")
    writeFileSync(path, "old\n")
    rename.fail = code
    expect(writeIfChanged(path, "new\n")).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(readdirSync(dir)).toEqual(["hooks.ts"])
  })

  it("still fails on another rename error, leaving no temporary file", () => {
    const path = join(dir, "hooks.ts")
    writeFileSync(path, "old\n")
    rename.fail = "EXDEV"
    expect(() => writeIfChanged(path, "new\n")).toThrow("EXDEV")
    expect(readdirSync(dir)).toEqual(["hooks.ts"])
  })

  it("leaves a file that already holds the text untouched", () => {
    const path = join(dir, "hooks.ts")
    writeFileSync(path, "same\n")
    rename.fail = "EPERM"
    expect(writeIfChanged(path, "same\n")).toBe(false)
  })
})
