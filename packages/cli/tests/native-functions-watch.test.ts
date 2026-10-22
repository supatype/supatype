import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { refreshNativeFunctionsRouter } from "../src/native-functions-watch.js"

/**
 * C6 follow-up, native dev: the server runs Deno with `--watch` on a router the CLI generates at
 * start, listing the functions it found then. Deno reloads when a function file changes, but a
 * function added afterwards is in no router, so it was never served. The router is regenerated
 * when the set of functions changes, and Deno's own watch reloads it.
 */
let cwd: string
const handler = "export default () => new Response('hi')\n"

function addFunction(name: string): void {
  mkdirSync(join(cwd, "functions", name), { recursive: true })
  writeFileSync(join(cwd, "functions", name, "index.ts"), handler)
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-fn-"))
  addFunction("hello")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev functions router", () => {
  it("is rewritten with a function added after dev started", () => {
    addFunction("bye")
    const names = refreshNativeFunctionsRouter(cwd, join(cwd, "functions"), ["hello"])
    expect(names).toEqual(["bye", "hello"])
    expect(readFileSync(join(cwd, ".supatype", "functions-router.ts"), "utf8")).toContain("bye")
  })

  it("is left alone when the set of functions has not changed", () => {
    expect(refreshNativeFunctionsRouter(cwd, join(cwd, "functions"), ["hello"])).toBeNull()
  })
})
