import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DetectedProjectSetup } from "../src/init-project-detect.js"

/**
 * Fresh-user findings on init's prompts: it asked the project name the argument already gave, and
 * asked "Production storage?" right after the production target was "Decide later".
 */

const asked = vi.hoisted(() => ({ messages: [] as string[], answers: new Map<string, unknown>() }))

vi.mock("../src/ui/clack.js", () => {
  const answer = (options: { message: string; initialValue?: unknown; defaultValue?: unknown }): Promise<unknown> => {
    asked.messages.push(options.message)
    const scripted = asked.answers.get(options.message)
    return Promise.resolve(scripted !== undefined ? scripted : (options.initialValue ?? options.defaultValue ?? ""))
  }
  return {
    p: { text: answer, select: answer, confirm: answer, password: answer, note: () => undefined, log: { warn: () => undefined } },
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

async function wizard(askName: boolean, answers: Record<string, unknown> = {}) {
  asked.messages.length = 0
  asked.answers = new Map(Object.entries({ "Create an admin user for Studio (/studio/)?": false, ...answers }))
  const { collectWizardAnswers } = await import("../src/commands/init.js")
  return collectWizardAnswers({ defaultName: "acme", defaultTarget: "later", dir: ".", detected, askName })
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
