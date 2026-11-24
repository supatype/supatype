import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { warnSpaIndexMissing } from "../src/stack-setting-warnings.js"

/**
 * D-99: Cloud refuses a `build.spa` fallback with no root index.html; self-host used to say nothing and
 * answered a missing page with a 404. It warns instead of refusing: the static folder is a live mount
 * that may be built after `compose up`.
 */

function staticProject(spa: boolean | undefined): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "static", static_dir: "./dist" },
    ...(spa !== undefined && { build: { spa } }),
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project directory whose ./dist exists, with an index.html when `withIndex`. */
function projectDir(withIndex: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-spa-warn-"))
  dirs.push(dir)
  mkdirSync(join(dir, "dist"))
  if (withIndex) writeFileSync(join(dir, "dist", "index.html"), "<html></html>", "utf8")
  return dir
}

function warnings(run: () => void): string[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    run()
    return warn.mock.calls.map((call) => String(call[0]))
  } finally {
    warn.mockRestore()
  }
}

describe("self-host SPA fallback without an index.html", () => {
  it("warns once when the fallback is on and the folder has no index.html", () => {
    const dir = projectDir(false)
    const lines = warnings(() => warnSpaIndexMissing(dir, staticProject(true)))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("has no index.html")
    expect(lines[0]).toContain("build.spa: false")
  })

  it("says nothing when the folder has an index.html", () => {
    expect(warnings(() => warnSpaIndexMissing(projectDir(true), staticProject(true)))).toEqual([])
  })

  it("says nothing when the fallback is off, or the app is not static", () => {
    expect(warnings(() => warnSpaIndexMissing(projectDir(false), staticProject(false)))).toEqual([])
    const proxy: SupatypeProjectConfig = { ...staticProject(true), app: { mode: "none" } }
    expect(warnings(() => warnSpaIndexMissing(projectDir(false), proxy))).toEqual([])
  })
})
