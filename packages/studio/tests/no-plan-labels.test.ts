import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Studio never tells a user which internal plan phase a feature belongs to.
 *
 * Unbuilt views used to read "Coming in Phase 25". The phase numbers are the team's planning
 * documents, mean nothing to somebody running Studio, and go stale the moment the plan moves. The
 * screen says "Coming soon" instead. Comments may still cite a plan; what a user reads may not.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url))
const PLAN_REFERENCE = /\bPhase[\s-]\d+|\bin a later phase\b/i

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** The file with its comments blanked, so only code and the strings it shows remain. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

describe("user-visible text", () => {
  it.each(sourceFiles(SRC).map((path) => [path.slice(SRC.length + 1), path]))(
    "%s cites no plan phase",
    (_name, path) => {
      const lines = withoutComments(readFileSync(path, "utf8")).split("\n")
      expect(lines.filter((line) => PLAN_REFERENCE.test(line))).toEqual([])
    },
  )
})
