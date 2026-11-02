import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { pathInside, resolveInside, toPosixPath } from "../src/index.js"

// Paths are built with resolve() and join() so each case reads the same on POSIX and on Windows.
const ROOT = resolve("/srv/app")

describe("pathInside()", () => {
  it("is true for a file or folder under the root", () => {
    expect(pathInside(ROOT, join(ROOT, "README.md"))).toBe(true)
    expect(pathInside(ROOT, join(ROOT, "src", "index.ts"))).toBe(true)
  })

  it("is false for the root itself", () => {
    expect(pathInside(ROOT, ROOT)).toBe(false)
  })

  it("is false for the parent and anything beside the root", () => {
    expect(pathInside(ROOT, resolve(ROOT, ".."))).toBe(false)
    expect(pathInside(ROOT, resolve(ROOT, "..", "other", "x.ts"))).toBe(false)
  })

  it("is false for a sibling whose name starts with the root's", () => {
    expect(pathInside(ROOT, resolve("/srv/app2/x.ts"))).toBe(false)
  })

  it("is true for a name that only starts with two dots", () => {
    expect(pathInside(ROOT, join(ROOT, "..notes"))).toBe(true)
    expect(pathInside(ROOT, join(ROOT, "...", "x"))).toBe(true)
  })

  it.runIf(process.platform === "win32")("is false on another drive", () => {
    expect(pathInside("C:\\srv\\app", "D:\\srv\\app\\x.ts")).toBe(false)
  })
})

describe("resolveInside()", () => {
  it("resolves a relative name against the root", () => {
    expect(resolveInside(ROOT, "src/index.ts")).toBe(join(ROOT, "src", "index.ts"))
  })

  it("is undefined for a name that lands outside the root", () => {
    expect(resolveInside(ROOT, "../escape.txt")).toBeUndefined()
    expect(resolveInside(ROOT, "a/../../escape.txt")).toBeUndefined()
    expect(resolveInside(ROOT, resolve("/etc/passwd"))).toBeUndefined()
  })

  it("is undefined for the root itself", () => {
    expect(resolveInside(ROOT, ".")).toBeUndefined()
    expect(resolveInside(ROOT, "a/..")).toBeUndefined()
  })
})

describe("toPosixPath()", () => {
  it("writes this platform's separator as a forward slash", () => {
    expect(toPosixPath(join("edge", "_shared", "context.ts"))).toBe("edge/_shared/context.ts")
    expect(toPosixPath("already/posix")).toBe("already/posix")
  })
})
