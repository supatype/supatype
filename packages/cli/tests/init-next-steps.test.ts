import { describe, expect, it } from "vitest"
import { initFirstSteps, initSecretLines, initStepBlocks, selfHostDeploySteps, type InitStepsArgs } from "../src/commands/init.js"

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
  it("ends at the project's dev script and where to open it, with no push after it", () => {
    expect(commands(initFirstSteps(args()))).toEqual(["cd acme", "pnpm dev", "Open http://localhost:18480"])
  })

  it("does not list push while setup is unfinished either", () => {
    const steps = commands(initFirstSteps(args({ installed: false, keysGenerated: false, binariesReady: false })))
    expect(steps).toEqual(["cd acme", "pnpm install", "supatype update", "supatype keys", "pnpm dev", "Open http://localhost:18480"])
  })

  it("says that dev applies the schema, so nobody goes looking for another command", () => {
    const dev = initFirstSteps(args()).find((step) => step.startsWith("pnpm dev"))
    expect(dev).toMatch(/applies the schema/)
  })

  it("says the first admin user is created by dev", () => {
    const steps = initFirstSteps(args({ result: { ...args().result, adminEmail: "ops@example.com" } }))
    expect(steps.join("\n")).toMatch(/first admin user is created on dev\b/)
    expect(steps.join("\n")).not.toMatch(/or push/)
  })

  it.each([
    ["npm", "npm run dev"],
    ["yarn", "yarn dev"],
    ["bun", "bun run dev"],
  ] as const)("runs the dev script the way %s does", (packageManager, command) => {
    const steps = commands(initFirstSteps(args({ result: { ...args().result, packageManager } })))
    expect(steps).toContain(command)
  })

  it("runs supatype:dev when the project's own dev script is something else", () => {
    const steps = commands(initFirstSteps({ ...args(), devScript: "supatype:dev" }))
    expect(steps).toContain("pnpm supatype:dev")
  })

  it("lines up each comment under the first", () => {
    const steps = initFirstSteps(args({ result: { ...args().result, adminEmail: "ops@example.com" } }))
    const columns = new Set(steps.filter((step) => step.includes("#")).map((step) => step.indexOf("#")))
    expect(columns.size).toBe(1)
  })
})

/**
 * Fresh-user test: a self-host project led with taking it to its server, its first step a domain
 * the person had just said they did not have. Local development comes first for every project, and
 * the self-host steps are printed last, under a title saying they are for later.
 */
describe("init's next steps for a self-host project", () => {
  const selfHost = (domain: string): InitStepsArgs => args({ result: { ...args().result, productionTarget: "self-host", domain } })

  it("leads with local development, like every other project", () => {
    expect(commands(initFirstSteps(selfHost("")))).toEqual(["cd acme", "pnpm dev", "Open http://localhost:18480"])
  })

  it("prints the self-host steps last, as the ones for when it is ready to deploy", () => {
    const blocks = initStepBlocks(selfHost(""))
    expect(blocks[0]!.title).toBe("Next steps:")
    expect(blocks.at(-1)!.title).toBe("When you're ready to deploy (self-host):")
    expect(blocks.at(-1)!.steps).toEqual(selfHostDeploySteps({ domain: "" }))
  })

  it("does not start with a domain nobody gave, and says it can come later", () => {
    const steps = selfHostDeploySteps({ domain: "" })
    expect(steps[0]).not.toMatch(/domain/)
    expect(steps.at(-1)).toMatch(/^Later, optionally:.*server\.domain/)
    expect(commands(steps)).toContain("supatype self-host compose up -d")
  })

  it("starts with DNS for the domain that was given", () => {
    expect(selfHostDeploySteps({ domain: "api.example.com" })[0]).toMatch(/A record for api\.example\.com/)
  })

  it("keeps the setup steps ahead of local development", () => {
    const steps = commands(initFirstSteps({ ...selfHost("api.example.com"), installed: false }))
    expect(steps).toEqual(["cd acme", "pnpm install", "pnpm dev", "Open http://localhost:18480"])
  })

  /**
   * Issue 29: a production build read no anon key, so a deployed app rendered a blank page. The
   * deploy steps build the app with `supatype build` once the deployment is linked, so the build is
   * given that deployment's address and key.
   */
  it.each(["", "api.example.com"])("builds the app with supatype build after linking (domain %o)", (domain) => {
    const steps = commands(selfHostDeploySteps({ domain }))
    const link = steps.findIndex((step) => step.startsWith("supatype link"))
    expect(link).toBeGreaterThanOrEqual(0)
    expect(steps.indexOf("supatype build --env production")).toBeGreaterThan(link)
  })

  it("builds the app with supatype build after pushing to Supatype Cloud", () => {
    const blocks = initStepBlocks(args({ result: { ...args().result, productionTarget: "cloud" } }))
    const steps = commands(blocks.at(-1)!.steps)
    expect(steps.indexOf("supatype build --env production")).toBeGreaterThan(steps.indexOf("supatype push --env production"))
  })

  it("prints no deploy block when production is decided later", () => {
    const titles = initStepBlocks(args({ result: { ...args().result, productionTarget: "later" } })).map((b) => b.title)
    expect(titles.some((title) => /deploy/i.test(title))).toBe(false)
  })
})

/** Fresh-user test: the secrets were padded by hand, so their descriptions started in four places. */
describe("init's secrets list", () => {
  it("starts every description in one column, two spaces past the longest name", () => {
    const lines = initSecretLines()
    const longest = Math.max(...lines.map((line) => line.split(" ")[0]!.length))
    for (const line of lines) {
      expect(line.slice(longest, longest + 2)).toBe("  ")
      expect(line[longest + 2]).not.toBe(" ")
    }
  })

  it("keeps the closing sentence out of the list", () => {
    expect(initSecretLines().some((line) => line.startsWith("Keep .env"))).toBe(false)
    expect(initStepBlocks(args()).find((b) => b.title.startsWith("Secrets"))!.after).toMatch(/^Keep \.env/)
  })
})
