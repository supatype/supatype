/**
 * The CLI runs packages/cli/dist, not src. A dist built before the pin commit pinned tags the CDN
 * does not have, and a build proof that only hashed the dist at start and end never noticed.
 * `release-images.mjs check-dist` compares the compiled copy with release/images.json.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")
const SCRIPT = join(REPO_ROOT, "scripts", "release-images.mjs")

interface Pin {
  readonly image: string
  readonly tag: string
  readonly commit: string
}

const pins = JSON.parse(readFileSync(join(REPO_ROOT, "release", "images.json"), "utf8")) as Record<string, Pin>
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** What tsc emits for generated/release-images.ts, with `override` swapped in for one component's tag. */
function compiledDist(override?: { readonly name: string; readonly tag: string }): string {
  const lines = Object.entries(pins).map(([name, pin]) => {
    const tag = override?.name === name ? override.tag : pin.tag
    return `    ${name}: { image: "${pin.image}", tag: "${tag}", commit: "${pin.commit}" },`
  })
  return ["export const PINNED_IMAGES = {", ...lines, "};", ""].join("\n")
}

function checkDist(text: string | undefined): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "dist-pins-"))
  dirs.push(dir)
  const file = join(dir, "release-images.js")
  if (text !== undefined) writeFileSync(file, text, "utf8")
  const run = spawnSync(process.execPath, [SCRIPT, "check-dist", file], { encoding: "utf8" })
  return { status: run.status, stderr: run.stderr }
}

describe("release-images.mjs check-dist", () => {
  it("passes when the dist carries the pins in release/images.json", () => {
    expect(checkDist(compiledDist())).toEqual({ status: 0, stderr: "" })
  })

  it("fails and names the component when the dist pins an older tag", () => {
    const run = checkDist(compiledDist({ name: "server", tag: "e2e-d07b10d7" }))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("server is e2e-d07b10d7")
    expect(run.stderr).toContain(`release/images.json says ${pins["server"]?.tag}`)
  })

  it("fails when the dist was never built", () => {
    const run = checkDist(undefined)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("missing or empty")
  })
})
