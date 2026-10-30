import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * One hung Docker daemon held whichever command met it first: the CLI spawned `docker` from some
 * thirty places, most with no limit. Every call now goes through docker-exec.ts, where each has
 * one; a spawn anywhere else would be back to waiting forever.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url))
const DIRECT_DOCKER_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*[`"']docker\b/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe("every docker call", () => {
  it("goes through docker-exec.ts", () => {
    const direct = sources(SRC)
      .filter((path) => relative(SRC, path) !== "docker-exec.ts")
      .filter((path) => DIRECT_DOCKER_SPAWN.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
    expect(direct).toEqual([])
  })
})
