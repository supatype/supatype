import { describe, expect, it } from "vitest"
import { generateFunctionsRouterSource } from "../src/functions-router-gen.js"

// The router the CLI generates for `supatype dev` used to serialise every invocation.
//
// Per-invocation configuration was delivered by mutating `Deno.env`, which is process-global, so
// two concurrent calls would read each other's values, including a service-role key granted to one
// route and not the other. The defence was a lock held across the whole handler, which meant one
// invocation at a time: a function waiting two seconds on a third-party API blocked every other
// function for two seconds.
//
// It was invisible because the deployed worker had the same lock, so local behaved exactly like
// production and there was nothing to compare against. Measured after the fix: four 300ms
// invocations complete in about 430ms through the worker and 655ms through this router, against
// ~1200ms serial.
//
// These assert the shape rather than the timing. A timing test here would need a Deno runtime and
// would be the slowest test in the suite; what actually regresses is somebody reintroducing the
// global mutation, and that is visible in the source.

const ROUTER = generateFunctionsRouterSource("/project/.supatype/functions-router.ts", [
  { name: "hello", entrypoint: "/project/functions/hello/index.ts" },
])

describe("the generated functions router", () => {
  it("holds no lock across a handler", () => {
    // Any of these names coming back means the serialisation is back.
    for (const banned of ["envLock", "withEnvLock", "runWithScopedEnv"]) {
      expect(ROUTER).not.toContain(banned)
    }
  })

  it("does not write per-invocation values into the process environment", () => {
    // `Deno.env.set` per invocation is the mechanism, and there is no safe amount of it: the
    // environment is shared by every invocation in the isolate, so one write is enough to need the
    // lock back.
    //
    // The one delete is the service-role key's, once at start before any handler is imported, as
    // the deployed worker does. The one set puts that key back when the router unloads, for the
    // evaluation a --watch reload starts next. Neither is per invocation: both are outside the
    // request handler, which Deno.serve takes last.
    expect(ROUTER.match(/Deno\.env\.delete\(/g)).toHaveLength(1)
    expect(ROUTER).toContain('Deno.env.delete("SUPATYPE_SERVICE_ROLE_KEY")')
    expect(ROUTER.match(/Deno\.env\.set\(/g)).toHaveLength(1)
    expect(ROUTER).toContain('Deno.env.set("SUPATYPE_SERVICE_ROLE_KEY", serviceRoleKey)')
    const serve = ROUTER.indexOf("Deno.serve(")
    expect(ROUTER.indexOf("Deno.env.delete(")).toBeLessThan(serve)
    expect(ROUTER.indexOf("Deno.env.set(")).toBeLessThan(serve)
  })

  it("passes the call's configuration to the handler instead", () => {
    expect(ROUTER).toContain("ctx: FunctionContext")
    expect(ROUTER).toContain("handlers[fnName]!(req, context)")
    // The service-role key reaches a route through the context or not at all.
    expect(ROUTER).toContain("serviceRoleKey")
  })

  it("keeps each invocation's identity in async context, not in a module variable", () => {
    // `console` is global and calls now genuinely interleave, so a captured line has to be
    // attributed to the invocation that wrote it. A module-level "current request" would
    // mis-attribute every interleaved line.
    expect(ROUTER).toContain("AsyncLocalStorage")
    expect(ROUTER).toContain("invocationStore.run(")
  })

  it("logs one JSON object per line, with the fields the cloud pipeline indexes on", () => {
    // Promtail parses each line as JSON and labels on these, taking the timestamp from a `timestamp`
    // field. A plain-text line is collected, matches no expression, and is indexed under no project.
    for (const field of ["timestamp", "level", "service", "project_ref", "request_id", "duration_ms"]) {
      expect(ROUTER).toContain(field)
    }
    expect(ROUTER).toContain("JSON.stringify(line)")
  })

  // The access line and the uncaught-error line are written after the invocation's async context
  // has ended, so they named no function, and a function's own log (which the server now filters
  // by `function`) left out its requests and its crashes.
  it("names the function on the access line and the error line written after an invocation", () => {
    const after = ROUTER.slice(ROUTER.indexOf("const start = performance.now()"))
    const extras = [...after.matchAll(/emit\("(?:info|error)", [^{]*\{([^}]*)\}/g)].map((m) => m[1] ?? "")
    expect(extras).toHaveLength(2)
    for (const extra of extras) {
      expect(extra).toContain("function: fnName")
      expect(extra).toContain("request_id: context.executionId")
    }
  })

  it("emits source that is valid to embed, with no stray template escapes", () => {
    // The generator builds this with a template literal, so an unescaped backtick or `${` silently
    // ends the literal and emits broken code. Cheap to assert, and it has bitten twice.
    expect(ROUTER).not.toContain("\\`")
    expect(ROUTER).not.toContain("\\${")
    expect(ROUTER).toContain('"hello": exportedHandler("hello", await import("')
  })
})
