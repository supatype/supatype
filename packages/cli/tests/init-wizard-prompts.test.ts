import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DetectedProjectSetup } from "../src/init-project-detect.js"

/**
 * Fresh-user findings on init's prompts: it asked the project name the argument already gave, and
 * asked "Production storage?" right after the production target was "Decide later".
 */

const asked = vi.hoisted(() => ({
  messages: [] as string[],
  answers: new Map<string, unknown>(),
  /** Answers given in turn, for a prompt asked more than once. */
  queued: new Map<string, unknown[]>(),
  warnings: [] as string[],
}))

vi.mock("../src/ui/clack.js", () => {
  const answer = (options: { message: string; initialValue?: unknown; defaultValue?: unknown }): Promise<unknown> => {
    asked.messages.push(options.message)
    const turn = asked.queued.get(options.message)?.shift()
    if (turn !== undefined) return Promise.resolve(turn)
    const scripted = asked.answers.get(options.message)
    return Promise.resolve(scripted !== undefined ? scripted : (options.initialValue ?? options.defaultValue ?? ""))
  }
  return {
    p: { text: answer, select: answer, confirm: answer, password: answer, note: () => undefined, log: { warn: (message: string) => asked.warnings.push(message) } },
    isCancel: () => false,
    CLACK_CANCEL: Symbol.for("cancel"),
  }
})
vi.mock("../src/dev-ports.js", () => ({ promptKongPortChoice: () => Promise.resolve(18473) }))

const detected: DetectedProjectSetup = {
  hasExistingFiles: false,
  hasSupatypeConfig: false,
  hasVite: false,
  hasViteConfig: false,
  viteDevUrl: "http://localhost:5173",
  staticDir: "./dist",
  summaryLines: [],
}

async function wizard(askName: boolean, answers: Record<string, unknown> = {}, found: DetectedProjectSetup = detected) {
  asked.messages.length = 0
  asked.answers = new Map(Object.entries({ "Create an admin user for Studio (/studio/)?": false, ...answers }))
  const { collectWizardAnswers } = await import("../src/commands/init.js")
  return collectWizardAnswers({ defaultName: "acme", defaultTarget: "later", detected: found, askName })
}

describe("init's wizard", () => {
  beforeEach(() => {
    asked.messages.length = 0
  })

  it("does not ask the project name the argument gave", async () => {
    const result = await wizard(false)
    expect(asked.messages).not.toContain("Project name")
    expect(result.projectName).toBe("acme")
  })

  it("asks the project name when no argument gave one", async () => {
    const result = await wizard(true, { "Project name": "other" })
    expect(asked.messages).toContain("Project name")
    expect(result.projectName).toBe("other")
  })

  it("does not ask for production storage when production is decided later", async () => {
    const result = await wizard(false)
    expect(asked.messages).not.toContain("Production storage?")
    expect(result.storageProduction).toBe(result.storageLocal)
  })

  it("asks for production storage for a production target", async () => {
    await wizard(false, { "Where will this run in production?": "cloud" })
    expect(asked.messages).toContain("Production storage?")
  })
})

/**
 * Fresh-user test: the admin password was asked once, so a typo became the Studio password with
 * nothing to show it. It is asked twice, and both are asked again when they differ.
 */
describe("init's admin password", () => {
  const PASSWORD = "Admin password (min 8 characters)"
  const CONFIRM = "Confirm admin password"
  const admin = { "Create an admin user for Studio (/studio/)?": true, "Admin email": "ops@example.com" }

  beforeEach(() => {
    asked.queued.clear()
    asked.warnings.length = 0
  })

  it("asks for it twice and keeps it when both match", async () => {
    asked.queued.set(PASSWORD, ["correct-horse"])
    asked.queued.set(CONFIRM, ["correct-horse"])
    const result = await wizard(false, admin)
    expect(asked.messages.filter((m) => m === CONFIRM)).toHaveLength(1)
    expect(result.adminPassword).toBe("correct-horse")
  })

  it("warns and asks both again when they do not match", async () => {
    asked.queued.set(PASSWORD, ["correct-horse", "battery-staple"])
    asked.queued.set(CONFIRM, ["correct-hrose", "battery-staple"])
    const result = await wizard(false, admin)
    expect(asked.warnings).toContain("Passwords do not match.")
    expect(asked.messages.filter((m) => m === PASSWORD)).toHaveLength(2)
    expect(asked.messages.filter((m) => m === CONFIRM)).toHaveLength(2)
    expect(result.adminPassword).toBe("battery-staple")
  })

  it("does not ask for the confirmation of a password too short to use", async () => {
    asked.queued.set(PASSWORD, ["short", "long-enough"])
    asked.queued.set(CONFIRM, ["long-enough"])
    const result = await wizard(false, admin)
    expect(asked.messages.filter((m) => m === CONFIRM)).toHaveLength(1)
    expect(result.adminPassword).toBe("long-enough")
  })
})

/**
 * Fresh-user test: "Directory to serve" came before the Vite question, so a new Vite project was
 * offered ./public, which is Vite's own folder for static assets rather than its build output. The
 * Vite question comes first; the directory then defaults to ./dist for Vite and stays ./public for a
 * plain site, and picking ./public for a Vite project is warned about.
 */
describe("init's static site directory", () => {
  const DIRECTORY = "Directory to serve"
  const VITE = "Develop locally with Vite (live reload)?"
  const staticSite = (vite: boolean, extra: Record<string, unknown> = {}) => ({
    "Host a frontend app at /?": "static",
    [VITE]: vite,
    ...extra,
  })

  beforeEach(() => {
    asked.warnings.length = 0
  })

  it("asks about Vite before the directory", async () => {
    await wizard(false, staticSite(true))
    expect(asked.messages.indexOf(VITE)).toBeGreaterThanOrEqual(0)
    expect(asked.messages.indexOf(VITE)).toBeLessThan(asked.messages.indexOf(DIRECTORY))
  })

  // A fresh directory, where detection finds nothing and offers ./public.
  const fresh: DetectedProjectSetup = { ...detected, staticDir: "./public" }

  it("defaults to ./dist for a Vite project", async () => {
    expect((await wizard(false, staticSite(true), fresh)).app.staticDir).toBe("./dist")
  })

  it("keeps ./public for a site with no build", async () => {
    expect((await wizard(false, staticSite(false), fresh)).app.staticDir).toBe("./public")
  })

  it("offers a directory found in the project for a site with no build", async () => {
    expect((await wizard(false, staticSite(false))).app.staticDir).toBe("./dist")
  })

  it("warns, without refusing, when a Vite project serves ./public", async () => {
    const result = await wizard(false, staticSite(true, { [DIRECTORY]: "./public" }))
    expect(result.app.staticDir).toBe("./public")
    expect(asked.warnings.some((warning) => /public.*Vite/i.test(warning))).toBe(true)
  })

  it("does not warn about ./public for a site with no build", async () => {
    await wizard(false, staticSite(false, { [DIRECTORY]: "./public" }))
    expect(asked.warnings).toEqual([])
  })
})
