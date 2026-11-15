import { describe, expect, it } from "vitest"
import { denoPreflightWarning } from "../src/native-worker.js"

/**
 * The server starts Deno for the functions worker and keeps its output to itself. Deno that cannot
 * start in the project folder (0.9.3 run: Deno 2.2.0 beside a version 5 deno.lock written by 2.9.8,
 * "Failed reading lockfile") left every function answering 502 with an empty body and nothing in
 * dev's output. Dev now asks Deno to start in the folder once, as it asks PostgREST, and says why.
 */
const ran = (status: number, stderr: string) => () => ({ status, stdout: "", stderr })

describe("the Deno preflight before native dev starts the worker", () => {
  it("names Deno's own error and the 502s it causes", () => {
    const warning = denoPreflightWarning("deno.exe", "/p", ran(1, "error: Failed reading lockfile at '/p/deno.lock'\n\nCaused by:\n    Unsupported lockfile version '5'"))
    expect(warning).toContain("Failed reading lockfile")
    expect(warning).toContain("Unsupported lockfile version '5'")
    expect(warning).toContain("502")
  })

  it("says nothing when Deno starts", () => {
    expect(denoPreflightWarning("deno.exe", "/p", ran(0, ""))).toBeNull()
  })

  it("says nothing when no Deno was provisioned, which dev already reports", () => {
    expect(denoPreflightWarning(undefined, "/p", ran(1, "never run"))).toBeNull()
  })
})
