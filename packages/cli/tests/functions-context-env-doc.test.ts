import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { functionsContextModuleSource } from "../src/functions-deno-types.js"

/**
 * `ctx.env` was documented as "values from .env and .env.<function>.local". The worker and the
 * local router read `.env.local` in the functions directory (or SUPATYPE_SHARED_ENV_FILE) and then
 * `.env.<function>.local`, which wins; the project's `.env` is never read for it. A developer
 * following the comment put a function's settings in `.env` and found them missing.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const COPIES = [
  "examples/blog/functions/_shared/context.ts",
  "examples/edge-kit/functions/_shared/context.ts",
  "examples/framework-parity/functions/_shared/context.ts",
  "examples/kitchen-sink/functions/_shared/context.ts",
  "tests/integration/functions/_shared/context.ts",
]

const read = (path: string): string => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n")

describe("ctx.env's documentation", () => {
  it("names the files the worker reads, and which one wins", () => {
    const source = functionsContextModuleSource()
    expect(source).toContain(".env.local")
    expect(source).toContain(".env.<function>.local")
    expect(source).not.toMatch(/Values from \.env and/)
  })

  it("says the same in the worker's own type", () => {
    const worker = read("packages/functions-worker/invocation.ts")
    expect(worker).toContain("SUPATYPE_SHARED_ENV_FILE")
    expect(worker).not.toMatch(/Values from `\.env` and/)
  })

  // Round 6b, N28b: values set with `functions env set` or the env files arrive in ctx.env, per
  // call, and never in Deno.env, which every call shares. Nothing said so, and a function reading
  // Deno.env.get found nothing.
  it("says the values arrive in ctx.env per call, never in Deno.env, and why", () => {
    const source = functionsContextModuleSource()
    expect(source).toContain("functions env set")
    expect(source).toMatch(/never in Deno\.env: .*one process environment, shared by[\s*]+every[\s*]+call/s)
    expect(read("packages/functions-worker/invocation.ts")).toMatch(/never in `Deno\.env`/)
    expect(read("docs-content/functions.md")).toMatch(/never in `Deno\.env`: .*shared by every call/s)
    expect(read("skills/supatype/references/cli.md")).toMatch(/supatype functions env set.*ctx\.env.*never in `Deno\.env`/)
  })

  it("is not described as Deno.env in the edge-kit example", () => {
    for (const path of ["examples/edge-kit/README.md", "examples/edge-kit/src/App.tsx", "examples/edge-kit/functions/env-check/index.ts", "examples/edge-kit/functions/write-note/index.ts"]) {
      expect(read(path), path).not.toMatch(/Deno\.env/)
    }
  })

  for (const copy of COPIES) {
    it(`is current in ${copy}`, () => {
      expect(read(copy)).toBe(functionsContextModuleSource().replace(/\r\n/g, "\n"))
    })
  }
})
