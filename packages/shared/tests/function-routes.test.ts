import { describe, expect, it } from "vitest"
import { functionRouteName, isFunctionName, isHookName } from "../src/index.js"

/**
 * The functions worker discovers its routes by functionRouteName, and a self-hosted control plane
 * lists functions by it; the worker gets a copy of the file (scripts/functions-worker-source.mjs).
 */
describe("functionRouteName", () => {
  it("names a directory and a .ts file, without the extension", () => {
    expect(functionRouteName("hello", "directory")).toBe("hello")
    expect(functionRouteName("hello.ts", "file")).toBe("hello")
  })

  it("skips _ and . entries, declaration files and anything not .ts", () => {
    expect(functionRouteName("_shared", "directory")).toBeUndefined()
    expect(functionRouteName(".git", "directory")).toBeUndefined()
    expect(functionRouteName("_util.ts", "file")).toBeUndefined()
    expect(functionRouteName("types.d.ts", "file")).toBeUndefined()
    expect(functionRouteName("README.md", "file")).toBeUndefined()
    expect(functionRouteName("data.json", "file")).toBeUndefined()
  })
})

/** Hooks take their names as written (onUserCreate), and must still be one safe path segment. */
describe("isHookName", () => {
  it("takes what a function name takes, and mixed case", () => {
    for (const name of ["tag-note", "on_user", "onUserCreate", "A1"]) expect(isHookName(name), name).toBe(true)
    expect(isFunctionName("onUserCreate")).toBe(false)
  })

  it("refuses anything that is not one safe path segment, or that the worker would skip", () => {
    for (const name of ["", "..", "../x", "a/b", "a\\b", ".hidden", "_supatype", "-lead", "a.b", "a:b", 1]) {
      expect(isHookName(name), JSON.stringify(name)).toBe(false)
    }
  })
})
