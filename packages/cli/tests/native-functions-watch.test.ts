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

  // Local test round 6c, N30: a hook made before any model named it imports
  // `../_supatype/hooks.ts`, which only a push writes, so it failed to load. The push then wrote the
  // adapter, which changed no route, and Deno does not watch a module that failed to import, so
  // nothing reloaded the worker and every write to the table answered 503.
  describe("when the generated hooks adapter changes", () => {
    const adapter = (): string => join(cwd, "hooks", "_supatype", "hooks.ts")
    function writeAdapter(text: string): void {
      mkdirSync(join(cwd, "hooks", "_supatype"), { recursive: true })
      writeFileSync(adapter(), text)
    }

    beforeEach(() => {
      addHandler("hooks", "tag-note")
      // Dev's entry as it started: the hook there, its adapter not yet.
      expect(refreshNativeFunctionsEntry(target(true), ["hello"])).toEqual(["hello", "hooks/tag-note"])
    })

    it("is rewritten when a push writes the adapter for the first time", () => {
      const before = readFileSync(devFunctionsEntryPath(cwd), "utf8")
      writeAdapter("export const hook = (h) => h\n")
      expect(refreshNativeFunctionsEntry(target(true), ["hello", "hooks/tag-note"])).toEqual(["hello", "hooks/tag-note"])
      expect(readFileSync(devFunctionsEntryPath(cwd), "utf8")).not.toBe(before)
    })

    it("is rewritten when the adapter's content changes, and left alone when it has not", () => {
      writeAdapter("export const hook = (h) => h\n")
      refreshNativeFunctionsEntry(target(true), ["hello", "hooks/tag-note"])
      expect(refreshNativeFunctionsEntry(target(true), ["hello", "hooks/tag-note"])).toBeNull()
      writeAdapter("export const hook = (h) => h // changed\n")
      expect(refreshNativeFunctionsEntry(target(true), ["hello", "hooks/tag-note"])).toEqual(["hello", "hooks/tag-note"])
    })
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

  // Local test round 3 N4: a hook declared while dev runs is in the manifest once the schema push
  // writes it, so the worker must serve it then, even from a hooks directory made after dev started,
  // which no watcher was set on.
  it("is rewritten on request, with a hook in a directory made after dev started", () => {
    const watcher = watchNativeFunctions(target(true), ["hello"], () => ({ close: () => undefined }))
    addHandler("hooks", "audit")
    watcher.refresh()
    watcher.close()
    expect(readFileSync(devFunctionsEntryPath(cwd), "utf8")).toContain("// Routes: hello, hooks/audit")
  })
})

/**
 * Local test round 3d (N19): in a project with no functions/ and no hooks/ when dev started, the
 * first hook or function added while it ran was never served. The worker now always runs, and the
 * directories are watched for appearing.
 */
describe("native dev's functions watch, for a directory made after dev started", () => {
  type Listener = (event: string, filename: string | null) => void

  it("watches hooks/ once it appears, and rewrites the entry with its hook", () => {
    vi.useFakeTimers()
    const listeners = new Map<string, Listener>()
    const fakeWatch = (dir: string, _options: { recursive: boolean }, listener: Listener): { close: () => void } => {
      listeners.set(dir, listener)
      return { close: () => listeners.delete(dir) }
    }
    const fresh: NativeFunctionsTarget = { ...target(true), hooksDir: join(cwd, "hooks") }
    const watcher = watchNativeFunctions(fresh, ["hello"], fakeWatch)
    expect(listeners.has(join(cwd, "hooks"))).toBe(false)

    addHandler("hooks", "audit")
    listeners.get(cwd)?.("rename", "hooks")
    vi.advanceTimersByTime(1_000)

    expect(listeners.has(join(cwd, "hooks"))).toBe(true)
    expect(readFileSync(devFunctionsEntryPath(cwd), "utf8")).toContain("// Routes: hello, hooks/audit")
    watcher.close()
    vi.useRealTimers()
  })
})
