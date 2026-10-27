import { describe, expect, it } from "vitest"
import { initFirstSteps, type InitStepsArgs } from "../src/commands/init.js"

/**
 * The steps `init` prints once the project exists.
 *
 * They said to run `supatype push` after `supatype dev`. `dev` already applies the schema, generates
 * the types and watches both, so the extra step sent a new user to the command meant for another
 * database (`push --env <name>`) as if the local one needed it.
 */
const args = (overrides: Partial<InitStepsArgs> = {}): InitStepsArgs => ({
  name: "acme",
  result: { provider: "docker", kongPort: 18480, packageManager: "pnpm", helloFunction: false },
  installed: true,
  keysGenerated: true,
  binariesReady: true,
  ...overrides,
})

const commands = (steps: string[]): string[] => steps.map((step) => step.split("#")[0]!.trim()).filter((s) => s !== "")

describe("init's next steps", () => {
  it("ends at supatype dev when setup is complete, with no push after it", () => {
    expect(commands(initFirstSteps(args()))).toEqual(["cd acme", "supatype dev"])
  })

  it("does not list push while setup is unfinished either", () => {
    const steps = commands(initFirstSteps(args({ installed: false, keysGenerated: false, binariesReady: false })))
    expect(steps).toEqual(["cd acme", "pnpm install", "supatype update", "supatype keys", "supatype dev"])
  })

  it("says that dev applies the schema, so nobody goes looking for another command", () => {
    const dev = initFirstSteps(args()).find((step) => step.startsWith("supatype dev"))
    expect(dev).toMatch(/applies the schema/)
  })

  it("says the first admin user is created by dev", () => {
    const steps = initFirstSteps(args({ result: { ...args().result, adminEmail: "ops@example.com" } }))
    expect(steps.join("\n")).toMatch(/first admin user is created on dev\b/)
    expect(steps.join("\n")).not.toMatch(/or push/)
  })
})

/**
 * `init --mode standalone --defaults` sets the project up for its own server, and its next steps
 * led with `supatype dev`. They lead with the self-host steps; local development comes after.
 */
describe("init's next steps for a self-host project", () => {
  const selfHost = (domain: string): InitStepsArgs => args({ result: { ...args().result, productionTarget: "self-host", domain } })

  it("leads with the self-host steps, not supatype dev", () => {
    const steps = commands(initFirstSteps(selfHost("")))
    expect(steps[0]).toBe("cd acme")
    expect(steps[1]).toMatch(/server\.domain/)
    expect(steps).toContain("supatype self-host compose up -d")
    expect(steps).not.toContain("supatype dev")
  })

  it("keeps the setup steps ahead of the self-host ones", () => {
    const steps = commands(initFirstSteps({ ...selfHost("api.example.com"), installed: false }))
    expect(steps.slice(0, 2)).toEqual(["cd acme", "pnpm install"])
  })

  it("still leads with supatype dev when production is decided later", () => {
    const steps = commands(initFirstSteps(args({ result: { ...args().result, productionTarget: "later" } })))
    expect(steps).toEqual(["cd acme", "supatype dev"])
  })
})
