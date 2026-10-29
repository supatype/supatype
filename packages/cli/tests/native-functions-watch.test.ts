import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { devFunctionsEntryPath } from "../src/functions-worker-files.js"
import { refreshNativeFunctionsEntry, watchNativeFunctions, type NativeFunctionsTarget } from "../src/native-functions-watch.js"

/**
 * C6 follow-up, native dev: the server runs Deno with `--watch` on an entry the CLI writes at
 * start, which imports the functions worker. Deno reloads when a file the worker imported changes,
 * but a function or hook added afterwards was imported by nothing, so it was never served. The
 * entry names the routes and is rewritten when that set changes, which is what makes Deno reload.
 */
let cwd: string
const handler = "export default () => new Response('hi')\n"

function target(functions: boolean): NativeFunctionsTarget {
  return {
    cwd,
    functionsDir: functions ? join(cwd, "functions") : undefined,
    hooksDir: join(cwd, "hooks"),
    workerMain: join(cwd, "cache", "main.ts"),
  }
}

function addHandler(dir: string, name: string): void {
  mkdirSync(join(cwd, dir, name), { recursive: true })
  writeFileSync(join(cwd, dir, name, "index.ts"), handler)
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-fn-"))
  addHandler("functions", "hello")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev functions entry", () => {
  it("is rewritten with a function added after dev started", () => {
    addHandler("functions", "bye")
    expect(refreshNativeFunctionsEntry(target(true), ["hello"])).toEqual(["bye", "hello"])
    expect(readFileSync(devFunctionsEntryPath(cwd), "utf8")).toContain("// Routes: bye, hello")
  })

  it("is rewritten with a hook added after dev started", () => {
    addHandler("hooks", "audit")
    expect(refreshNativeFunctionsEntry(target(true), ["hello"])).toEqual(["hello", "hooks/audit"])
    expect(readFileSync(devFunctionsEntryPath(cwd), "utf8")).toContain("// Routes: hello, hooks/audit")
  })

  it("names a project's hooks when it has no functions directory", () => {
    addHandler("hooks", "audit")
    addHandler("hooks", "notify")
    expect(refreshNativeFunctionsEntry(target(false), ["hooks/audit"])).toEqual(["hooks/audit", "hooks/notify"])
  })

  it("is left alone when the set of routes has not changed", () => {
    expect(refreshNativeFunctionsEntry(target(true), ["hello"])).toBeNull()
  })

  it("is watched in both the functions and the hooks directory", () => {
    addHandler("hooks", "audit")
    const watched: string[] = []
    const watcher = watchNativeFunctions(target(true), ["hello"], (dir) => {
      watched.push(dir)
      return { close: () => undefined }
    })
    watcher.close()
    expect(watched).toEqual([join(cwd, "functions"), join(cwd, "hooks")])
  })
})
