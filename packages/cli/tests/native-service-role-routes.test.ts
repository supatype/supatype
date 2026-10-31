import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { refreshServiceRoleRoutes } from "../src/native-functions-watch.js"

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
