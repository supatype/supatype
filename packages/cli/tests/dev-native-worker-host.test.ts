import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The functions worker listens on every address unless SUPATYPE_FUNCTIONS_HOST names one, which is
 * right in its container and wrong on a developer's machine: native dev's server reaches the worker
 * on 127.0.0.1, and nothing else on the network should. The worker's environment is built inline in
 * the dev action, so this reads it there.
 */
describe("native dev's functions worker", () => {
  it("is told to listen on 127.0.0.1, beside the rest of the worker's environment", () => {
    const dev = readFileSync(new URL("../src/commands/dev.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    expect(dev).toMatch(/\.\.\.functionsWorkerEnv\(\{[^\n]*\}\),\n(\s*\/\/[^\n]*\n)*\s*SUPATYPE_FUNCTIONS_HOST: "127\.0\.0\.1",/)
  })
})
