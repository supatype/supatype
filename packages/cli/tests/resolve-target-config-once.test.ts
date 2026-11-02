import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tempProject } from "./support/command-run.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Reading supatype.config.ts runs it in a child process, about 0.6 s on Windows. Resolving a linked
 * target read it twice, once for the project and again for its branch defaults, so every
 * `functions env set/unset/list` on a self-host link paid for two (review of round 7, item C13).
 */
const loadConfig = vi.fn((): SupatypeProjectConfig => projectConfig({ project: { name: "acme" } }))
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig }))

const { resolveTarget } = await import("../src/resolve-target.js")

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("resolve-target-config-once")
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "self-host",
    projectRef: "acme",
    defaultEnvironment: "production",
    environments: { production: { name: "production", apiUrl: "https://sh.example.test", token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
  loadConfig.mockClear()
})

afterEach(() => project.remove())

describe("resolveTarget on a linked project", () => {
  it("reads the project's config once", () => {
    const target = resolveTarget(project.dir)
    expect(target.mode).toBe("self-host")
    expect(loadConfig).toHaveBeenCalledTimes(1)
  })

  it("takes the default environment from that same read", () => {
    loadConfig.mockReturnValue(projectConfig({ project: { name: "acme" }, environments: { default: "production" } }))
    expect(resolveTarget(project.dir).environment).toBe("production")
    expect(loadConfig).toHaveBeenCalledTimes(1)
  })
})
