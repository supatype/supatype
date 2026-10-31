import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configSnapshot, refreshServiceRoleRoutes, watchServiceRoleRoutes } from "../src/native-functions-watch.js"
import type { WatchFn } from "../src/dev-functions-watch.js"

/**
 * Native dev hands the worker \`functions.serviceRole\` through a file it reads on every reload. A
 * change to the config used to wait for a restart of \`supatype dev\`, which said nothing about it.
 */
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function target(routes: string[]): { routesPath: string; reloads: () => number; readRoutes: () => string[]; reload: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "supatype-sr-routes-"))
  dirs.push(dir)
  let reloads = 0
  return { routesPath: join(dir, "service-role-routes"), readRoutes: () => routes, reload: () => { reloads++ }, reloads: () => reloads }
}

describe("refreshServiceRoleRoutes", () => {
  it("writes the new list and reloads the worker when functions.serviceRole changed", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const t = target(["admin-report", "billing"])
    expect(refreshServiceRoleRoutes(t, ["admin-report"])).toEqual(["admin-report", "billing"])
    expect(readFileSync(t.routesPath, "utf8")).toBe("admin-report,billing")
    expect(t.reloads()).toBe(1)
  })

  it("does nothing when the list is the same", () => {
    const t = target(["admin-report"])
    expect(refreshServiceRoleRoutes(t, ["admin-report"])).toBeNull()
    expect(t.reloads()).toBe(0)
  })
})

describe("a functions.serviceRole change that cannot be applied", () => {
  // It runs from a timer: a throw there ended `supatype dev`.
  it("warns and keeps dev running when the routes file cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const t = target(["billing"])
    writeFileSync(t.routesPath, "a file, not a directory")
    const blocked = { ...t, routesPath: join(t.routesPath, "service-role-routes") }
    expect(() => refreshServiceRoleRoutes(blocked, [])).not.toThrow()
    expect(blocked.reloads()).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it("warns and keeps dev running when the worker cannot be reloaded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const t = { ...target(["billing"]), reload: () => { throw new Error("entry not writable") } }
    expect(() => refreshServiceRoleRoutes(t, [])).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})

describe("watchServiceRoleRoutes", () => {
  // Saving the config without changing it (or an editor touching it) loaded it again each time.
  it("reads the config again only when a config file's bytes changed", () => {
    vi.useFakeTimers()
    const t = target(["admin-report"])
    const dir = join(t.routesPath, "..")
    writeFileSync(join(dir, "supatype.config.ts"), "export default {}\n")
    let reads = 0
    let fire: (event: string, filename: string | null) => void = () => undefined
    const watch: WatchFn = (_path, _opts, listener) => {
      fire = listener
      return { close: () => undefined }
    }
    const watcher = watchServiceRoleRoutes({
      dir, configFiles: ["supatype.config.ts"], routesPath: t.routesPath,
      readRoutes: () => { reads++; return ["admin-report"] }, reload: t.reload, initial: ["admin-report"],
      baseline: configSnapshot(dir, ["supatype.config.ts"]),
    }, watch)
    fire("change", "supatype.config.ts")
    vi.advanceTimersByTime(1000)
    expect(reads).toBe(0)
    writeFileSync(join(dir, "supatype.config.ts"), "export default { functions: {} }\n")
    fire("change", "supatype.config.ts")
    vi.advanceTimersByTime(1000)
    expect(reads).toBe(1)
    watcher.close()
    vi.useRealTimers()
  })
})

describe("a config edit made while dev was starting", () => {
  // Review of round 5: dev reads functions.serviceRole as it starts, and the watch started minutes
  // later took the bytes then as its baseline, so an edit in between was never applied.
  it("is applied when the watch starts, with no further save", () => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const t = target(["admin-report", "billing"])
    const dir = join(t.routesPath, "..")
    writeFileSync(join(dir, "supatype.config.ts"), "export default {}\n")
    const baseline = configSnapshot(dir, ["supatype.config.ts"])
    writeFileSync(join(dir, "supatype.config.ts"), "export default { functions: { serviceRole: ['billing'] } }\n")
    const watch: WatchFn = () => ({ close: () => undefined })
    const watcher = watchServiceRoleRoutes({
      dir, configFiles: ["supatype.config.ts"], routesPath: t.routesPath,
      readRoutes: t.readRoutes, reload: t.reload, initial: ["admin-report"], baseline,
    }, watch)
    vi.advanceTimersByTime(1000)
    expect(readFileSync(t.routesPath, "utf8")).toBe("admin-report,billing")
    expect(t.reloads()).toBe(1)
    watcher.close()
    vi.useRealTimers()
  })
})
