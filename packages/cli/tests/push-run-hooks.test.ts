import { describe, expect, it } from "vitest"
import { endpointToArgs } from "../src/engine-client.js"
import { composeEnginePushArgs } from "../src/dev-compose.js"
import { RUN_HOOKS_NEED } from "../src/engine-ownership-gate.js"

/**
 * A push's data migrations (column conversions, block moves, kind-change updates) are writes too, and
 * after-hooks read every write from the change log. The engine marks them so the listener skips
 * them; `push --run-hooks` keeps them firing. Off unless asked: a conversion over a whole table is
 * not a thousand events anyone meant to send.
 */
describe("push --run-hooks reaches the engine", () => {
  it("is passed to the engine binary as --run-hooks, and only when asked", () => {
    const files = { reqFile: "/tmp/req.json" }
    expect(endpointToArgs("/push", { ast: {}, run_hooks: true }, files)).toContain("--run-hooks")
    expect(endpointToArgs("/push", { ast: {} }, files)).not.toContain("--run-hooks")
  })

  it("is passed to the compose engine container as --run-hooks, and only when asked", () => {
    expect(composeEnginePushArgs(null, { runHooks: true })).toContain("--run-hooks")
    expect(composeEnginePushArgs(null, {})).not.toContain("--run-hooks")
  })

  it("is refused by an engine that does not list it, rather than sent", () => {
    expect(RUN_HOOKS_NEED).toEqual({ feature: "run_hooks", flag: "--run-hooks" })
  })
})
