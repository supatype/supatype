import { describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Fresh-user test C4: `supatype engine status` printed "Checking engine at
 * http://localhost:7500..." and "Engine is reachable and healthy." Nothing listens on 7500; all it
 * did was run the engine binary's `--version`. It now says that is what it checked.
 */
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  engineVersionCheck: async () => ({ ok: true, bin: "/cache/engine/supatype-engine", version: "supatype-engine 0.7.0" }),
}))

import { registerEngine } from "../src/commands/engine.js"

describe("engine status", () => {
  it("names the binary it ran and the version it answered, and no URL", async () => {
    const project = tempProject("engine-status")
    try {
      const run = await runCommand(registerEngine, ["engine", "status"], project.dir)
      expect(run.output).not.toContain("localhost:7500")
      expect(run.output).not.toContain("reachable")
      expect(run.output).toContain("/cache/engine/supatype-engine")
      expect(run.output).toContain("supatype-engine 0.7.0")
      expect(run.output).toContain("--version")
    } finally {
      project.remove()
    }
  })
})
