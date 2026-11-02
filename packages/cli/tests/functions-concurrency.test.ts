import { describe, expect, it } from "vitest"
import { FUNCTIONS_WORKER_SOURCE } from "../src/generated/functions-worker-source.js"

// The functions worker used to serialise every invocation, and so did the router native dev ran
// in its place, which copied it.
//
// Per-invocation configuration was delivered by mutating `Deno.env`, which is process-global, so
// two concurrent calls would read each other's values, including a service-role key granted to one
// route and not the other. The defence was a lock held across the whole handler, which meant one
// invocation at a time: a function waiting two seconds on a third-party API blocked every other
// function for two seconds.
//
// Native dev, `functions serve` and the image now all run this one worker, the copy the CLI
// carries. These assert its shape rather than its timing: what actually regresses is somebody
// reintroducing the global mutation, and that is visible in the source.

const MAIN = FUNCTIONS_WORKER_SOURCE["main.ts"] ?? ""
const WORKER = Object.entries(FUNCTIONS_WORKER_SOURCE)
  .filter(([name]) => !name.endsWith(".d.ts"))
  .map(([, source]) => source)
  .join("\n")

describe("the functions worker", () => {
  it("holds no lock across a handler", () => {
    // Any of these names coming back means the serialisation is back.
    for (const banned of ["envLock", "withEnvLock", "runWithScopedEnv"]) {
      expect(WORKER).not.toContain(banned)
    }
  })

  it("does not write per-invocation values into the process environment", () => {
    // `Deno.env.set` per invocation is the mechanism, and there is no safe amount of it: the
    // environment is shared by every invocation in the isolate, so one write is enough to need the
    // lock back. The one delete is the service-role key's, once at start before any handler is
    // imported; a --watch reload reads the key from its file again.
    expect(WORKER.match(/Deno\.env\.delete\(/g)).toHaveLength(1)
    expect(MAIN).toContain('Deno.env.delete("SUPATYPE_SERVICE_ROLE_KEY")')
    expect(WORKER).not.toMatch(/Deno\.env\.set\(/)
    expect(MAIN.indexOf("Deno.env.delete(")).toBeLessThan(MAIN.indexOf("Deno.serve("))
  })

  it("passes the call's configuration to the handler instead", () => {
    expect(MAIN).toContain("const context: FunctionContext = {")
    expect(MAIN).toContain("handlers[fnName]!(req, context)")
  })

  it("keeps each invocation's identity in async context, not in a module variable", () => {
    // `console` is global and calls genuinely interleave, so a captured line has to be attributed
    // to the invocation that wrote it.
    expect(FUNCTIONS_WORKER_SOURCE["invocation.ts"]).toContain("new AsyncLocalStorage")
    expect(MAIN).toContain("runInvocation(context,")
  })

  it("logs one JSON object per line, with the fields the cloud pipeline indexes on", () => {
    for (const field of ["timestamp", "level", "service", "project_ref", "request_id", "duration_ms"]) {
      expect(WORKER).toContain(field)
    }
    expect(FUNCTIONS_WORKER_SOURCE["logging.ts"]).toContain("write(JSON.stringify(line))")
  })

  // Written after the invocation's async context has ended, so they name their function themselves:
  // the server keeps a function's own log by that field.
  it("names the function on the access line and the error line written after an invocation", () => {
    const after = MAIN.slice(MAIN.indexOf("const start = performance.now()"))
    // Each log( call there, up to the end of its fields.
    const extras = after.split(/\blog\(/).slice(1).map((call) => call.slice(0, call.indexOf("})")))
    expect(extras).toHaveLength(2)
    for (const extra of extras) {
      expect(extra).toContain("function: fnName")
      expect(extra).toContain("request_id: context.executionId")
    }
  })
})
