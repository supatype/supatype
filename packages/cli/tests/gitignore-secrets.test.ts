/**
 * The `.gitignore` we write has to cover the secrets we write.
 *
 * `supatype functions new` writes `functions/.env.local` with "These are NOT committed to git" at
 * the top of it, and nothing made that true: `.env` matches a file named exactly `.env`, and both
 * `.env.local` and `.env.<function>.local` were tracked.
 *
 * Asserted through `git check-ignore` rather than by reading the patterns, because the question is
 * what git does with them and a pattern that looks right is how this got shipped.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SUPATYPE_GITIGNORE_BLOCK, SUPATYPE_GITIGNORE_PATHS } from "../src/gitignore.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-ignore-"))
  execFileSync("git", ["init", "-q", "."], { cwd: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** What git itself says about a path, which is the only answer that counts. */
function ignored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], { cwd: dir })
    return true
  } catch {
    return false
  }
}

function writeIgnore(contents: string): void {
  writeFileSync(join(dir, ".gitignore"), contents, "utf8")
  mkdirSync(join(dir, "functions"), { recursive: true })
  mkdirSync(join(dir, "src"), { recursive: true })
  for (const f of [
    ".env",
    ".env.local",
    "functions/.env.local",
    "functions/.env.checkout.local",
    "src/index.ts",
    "src/env.local.ts",
  ]) {
    writeFileSync(join(dir, f), "x", "utf8")
  }
}

describe("the block written into an existing .gitignore", () => {
  beforeEach(() => writeIgnore(SUPATYPE_GITIGNORE_BLOCK))

  it("ignores the plain env file", () => {
    expect(ignored(".env")).toBe(true)
  })

  it("ignores the function env files, at the root and nested", () => {
    // The ones `supatype functions new` writes and the worker reads.
    expect(ignored(".env.local")).toBe(true)
    expect(ignored("functions/.env.local")).toBe(true)
    expect(ignored("functions/.env.checkout.local")).toBe(true)
  })

  it("does not swallow source files", () => {
    // `.env.*.local` is a glob, and a careless widening of it catches real code.
    expect(ignored("src/index.ts")).toBe(false)
    expect(ignored("src/env.local.ts")).toBe(false)
  })
})

describe("the two emitters", () => {
  it("agree, because they read one list", () => {
    // They were separate copies and had already drifted. The copy that drifts is the one found
    // when a key reaches a public repository.
    for (const path of SUPATYPE_GITIGNORE_PATHS) {
      expect(SUPATYPE_GITIGNORE_BLOCK).toContain(path)
    }
  })

  it("carries the env patterns `.env` alone does not cover", () => {
    expect(SUPATYPE_GITIGNORE_PATHS).toContain(".env.local")
    expect(SUPATYPE_GITIGNORE_PATHS).toContain(".env.*.local")
  })
})
