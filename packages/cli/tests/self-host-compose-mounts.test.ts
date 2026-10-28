import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, resolve, win32 } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { composeProjectName, writeSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"
import { isString } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"

/**
 * SA3: the generated compose file lives in `.supatype/self-host/`, and its bind mounts were written
 * relative to the project root. The CLI passes `--project-directory`, so its own runs resolved them
 * correctly, but compose resolves a relative path against the compose file's folder when that flag
 * is missing. A hand-run `docker compose -f .supatype/self-host/docker-compose.yml up server` then
 * mounted `.supatype/self-host` as the project: the server lost its admin config, manifest, API
 * config, functions and hooks (Studio said no schema had been pushed), and Docker created an empty
 * `.supatype/self-host/.supatype` on the host. Every host path is now absolute, so the file means
 * the same thing however compose is invoked.
 */

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-mounts-"))
  dirs.push(dir)
  return dir
}

/** A bind mount from the rendered file: where on the host, and where in the container. */
interface BindMount {
  source: string
  target: string
}

/** The value of a `key: value` line, without YAML quotes. */
function scalar(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s+(?:- )?${key}: (.+)$`).exec(line)
  if (match?.[1] === undefined) return undefined
  const raw = match[1].trim()
  return raw.startsWith("\"") ? parseJsonAs(raw, isString) : raw
}

/**
 * Every bind mount in a rendered compose file, in either syntax compose accepts: the short
 * `- source:target[:ro]` form or the long form with `source:` and `target:` keys. Named volumes
 * (a source with no path separator) are left out: compose owns where those live.
 */
function bindMounts(compose: string): BindMount[] {
  const mounts: BindMount[] = []
  const lines = compose.split("\n")
  lines.forEach((line, i) => {
    const source = scalar(line, "source")
    if (source !== undefined) {
      const target = lines.slice(i + 1, i + 4).map((l) => scalar(l, "target")).find((t) => t !== undefined)
      if (target !== undefined) mounts.push({ source, target })
      return
    }
    const short = /^\s+- "?((?:[A-Za-z]:)?[^:"]*):(\/[^:"]*)(?::ro)?"?$/.exec(line)
    if (short?.[1] !== undefined && short[2] !== undefined && /[/\\.]/.test(short[1])) {
      mounts.push({ source: short[1], target: short[2] })
    }
  })
  return mounts
}

function isAbsoluteAnywhere(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

/** A host path as the test compares it: resolved, with one separator. */
function normalized(path: string): string {
  return resolve(path).replace(/\\/g, "/")
}

describe("self-host compose bind mounts (SA3)", () => {
  it("names every host path absolutely, so compose resolves it the same with or without --project-directory", () => {
    const cwd = projectDir()
    const out = writeSelfHostCompose(cwd, config)
    const mounts = bindMounts(readFileSync(out.composePath, "utf8"))

    expect(mounts.length).toBeGreaterThan(0)
    for (const mount of mounts) {
      expect(isAbsoluteAnywhere(mount.source), `${mount.source} -> ${mount.target}`).toBe(true)
    }
  })

  it("points each mount at the project's own files, not at the compose file's folder", () => {
    const cwd = projectDir()
    const out = writeSelfHostCompose(cwd, config)
    const byTarget = new Map(
      bindMounts(readFileSync(out.composePath, "utf8")).map((m) => [m.target, normalized(m.source)]),
    )

    expect(byTarget.get("/project")).toBe(normalized(cwd))
    expect(byTarget.get("/project/.supatype")).toBe(normalized(join(cwd, ".supatype")))
    expect(byTarget.get("/etc/kong/kong.yml")).toBe(normalized(out.kongPath))
    expect(byTarget.get("/etc/seaweedfs/s3.json")).toBe(normalized(out.s3ConfigPath))
  })

  it("follows a moved project: rendering again from the new folder names the new folder", () => {
    const before = projectDir()
    const after = projectDir()
    writeSelfHostCompose(before, config)
    const out = writeSelfHostCompose(after, config)
    const compose = readFileSync(out.composePath, "utf8")

    expect(compose).not.toContain(normalized(before))
    const projectMount = bindMounts(compose).find((m) => m.target === "/project")
    expect(projectMount && normalized(projectMount.source)).toBe(normalized(after))
  })

  it("names the compose project, so a hand-run compose command reaches this stack rather than a new one", () => {
    const out = writeSelfHostCompose(projectDir(), config)
    const compose = readFileSync(out.composePath, "utf8")

    expect(compose).toMatch(new RegExp(`^name: ${composeProjectName(config.project.name)}$`, "m"))
  })
})

/** Every `NAME: value` line for one variable across the rendered file. */
function envValues(compose: string, name: string): string[] {
  return compose
    .split("\n")
    .map((line) => new RegExp(`^\\s+${name}: (.+)$`).exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined)
}

/**
 * The stack mounts the project at /project, and the worker, the server and the control plane were
 * all told the functions were at /project/functions whatever `functions.path` said, so a project
 * keeping them in `api/functions` had every function answer 404.
 */
describe("self-host compose functions directory", () => {
  it("points the worker, server and control plane at functions.path inside the project", () => {
    const cwd = projectDir()
    const out = writeSelfHostCompose(cwd, { ...config, functions: { path: "api/functions" } })
    const compose = readFileSync(out.composePath, "utf8")

    const values = [
      ...envValues(compose, "SUPATYPE_FUNCTIONS_ROOT"),
      ...envValues(compose, "SUPATYPE_DENO_FUNCTIONS_DIR"),
    ]
    expect(values.length).toBeGreaterThanOrEqual(4)
    for (const value of values) expect(value).toBe("/project/api/functions")
  })

  it("keeps /project/functions when functions.path is unset", () => {
    const out = writeSelfHostCompose(projectDir(), config)
    const compose = readFileSync(out.composePath, "utf8")
    for (const value of envValues(compose, "SUPATYPE_FUNCTIONS_ROOT")) expect(value).toBe("/project/functions")
  })

  it("follows the project root, where the hooks are too", () => {
    const cwd = projectDir()
    const out = writeSelfHostCompose(cwd, { ...config, supatype: { root: "backend" } })
    const compose = readFileSync(out.composePath, "utf8")
    for (const value of envValues(compose, "SUPATYPE_FUNCTIONS_ROOT")) expect(value).toBe("/project/backend/functions")
    expect(envValues(compose, "SUPATYPE_HOOKS_ROOT")).toEqual(["/project/backend/hooks"])
  })

  it("refuses a functions.path outside the project, which the stack cannot mount", () => {
    expect(() => writeSelfHostCompose(projectDir(), { ...config, functions: { path: "../shared/functions" } })).toThrow(
      /functions\.path.*outside the project directory/,
    )
  })
})
