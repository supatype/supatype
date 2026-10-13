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
