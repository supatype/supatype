import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DetectedProjectSetup } from "../src/init-project-detect.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * Manual test #37: init's admin email took `admin@...\r<password>\radmin@...`, a paste with line
 * breaks in it, and wrote it to `.env`, where it stopped the server and put the password in its
 * log. The email must be one address, and no text init asks for may hold a control character.
 */

type Validate = (value: string) => string | undefined

const asked = vi.hoisted(() => ({
  /** Each text prompt's message and validator, in the order asked. */
  texts: [] as { message: string; validate: ((value: string) => string | undefined) | undefined }[],
  answers: new Map<string, unknown>(),
  queued: new Map<string, unknown[]>(),
  warnings: [] as string[],
  errors: [] as string[],
}))

vi.mock("../src/ui/clack.js", () => {
  type Options = { message: string; initialValue?: unknown; defaultValue?: unknown; validate?: (value: string) => string | undefined }
  const answer = (options: Options): Promise<unknown> => {
    const turn = asked.queued.get(options.message)?.shift()
    if (turn !== undefined) return Promise.resolve(turn)
    const scripted = asked.answers.get(options.message)
    return Promise.resolve(scripted !== undefined ? scripted : (options.initialValue ?? options.defaultValue ?? ""))
  }
  const text = (options: Options): Promise<unknown> => {
    asked.texts.push({ message: options.message, validate: options.validate })
    return answer(options)
  }
  const warn = (message: string) => void asked.warnings.push(message)
  return {
    p: { text, select: answer, confirm: answer, password: answer, note: () => undefined, log: { warn, info: warn, error: warn, success: warn } },
    isCancel: () => false,
    CLACK_CANCEL: Symbol.for("cancel"),
  }
})
vi.mock("../src/dev-ports.js", () => ({
  promptKongPortChoice: () => Promise.resolve(18473),
  chooseInitKongPort: () => Promise.resolve(18473),
}))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (message: string) => void asked.errors.push(message),
}))

const detected: DetectedProjectSetup = {
  hasExistingFiles: false,
  hasSupatypeConfig: false,
  hasVite: false,
  hasViteConfig: false,
  viteDevUrl: "http://localhost:5173",
  staticDir: "./dist",
  summaryLines: [],
}

const ADMIN = "Create an admin user for Studio (/studio/)?"
const EMAIL = "Admin email"
const PASSWORD = "Admin password (min 8 characters)"
const CONFIRM = "Confirm admin password"
const PASTED = "admin@example.com\rcorrect-horse\radmin@example.com"

async function wizard(answers: Record<string, unknown>): Promise<Awaited<ReturnType<typeof import("../src/commands/init.js").collectWizardAnswers>>> {
  asked.texts.length = 0
  asked.answers = new Map(Object.entries({ [ADMIN]: true, [EMAIL]: "ops@example.com", ...answers }))
  const { collectWizardAnswers } = await import("../src/commands/init.js")
  return collectWizardAnswers({ defaultName: "acme", defaultTarget: "later", detected, askName: true })
}

function validatorOf(message: string): Validate {
  const found = asked.texts.find((prompt) => prompt.message === message)?.validate
  if (found === undefined) throw new Error(`"${message}" was asked with no validator`)
  return found
}

beforeEach(() => {
  asked.queued.clear()
  asked.queued.set(PASSWORD, ["correct-horse"])
  asked.queued.set(CONFIRM, ["correct-horse"])
  asked.warnings.length = 0
  asked.errors.length = 0
})

describe("init's admin email", () => {
  it.each([
    ["the pasted value with carriage returns in it", PASTED],
    ["a line feed", "admin@example.com\nmore"],
    ["no @", "admin.example.com"],
    ["a space", "admin @example.com"],
    ["two addresses", "a@example.com,b@example.com"],
    ["nothing", "   "],
  ])("is refused with %s", async (_what, value) => {
    await wizard({})
    const problem = validatorOf(EMAIL)(value)
    expect(problem).toBeDefined()
    expect(problem).not.toContain("correct-horse")
  })

  it("takes one address", async () => {
    await wizard({})
    expect(validatorOf(EMAIL)("ops@example.com")).toBeUndefined()
  })
})

describe("every text init asks for", () => {
  // Every branch of the wizard that asks for text: a self-hosted, proxied app developed with Vite.
  const everyBranch = {
    "Where will this run in production?": "self-host",
    "Production domain for ACME TLS (optional, can set later)": "api.example.com",
    "Host a frontend app at /?": "proxy",
    "Use Vite for local development?": true,
    "Develop locally with Vite (live reload)?": true,
  }

  it("refuses a control character", async () => {
    await wizard(everyBranch)
    expect(asked.texts.length).toBeGreaterThanOrEqual(8)
    const unchecked = asked.texts.filter((prompt) => prompt.validate?.("value\rmore") === undefined).map((p) => p.message)
    expect(unchecked).toEqual([])
  })

  it("still takes an ordinary answer, or none where a default stands", async () => {
    await wizard(everyBranch)
    const refused = asked.texts.filter((prompt) => prompt.message !== EMAIL && prompt.validate?.("") !== undefined)
    expect(refused.map((p) => p.message)).toEqual([])
  })
})

describe("init's admin password", () => {
  it("is asked again when it holds a control character", async () => {
    asked.queued.set(PASSWORD, ["correct-horse\rmore", "battery-staple"])
    asked.queued.set(CONFIRM, ["battery-staple"])
    const result = await wizard({})
    expect(result.adminPassword).toBe("battery-staple")
    expect(asked.warnings.some((w) => /control character/i.test(w))).toBe(true)
  })
})

describe("init's --admin-email", () => {
  let root = ""
  const tty = process.stdin.isTTY

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "supatype-init-email-"))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    exitThrows()
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true })
    rmSync(root, { recursive: true, force: true })
  })

  async function init(email: string): Promise<void> {
    const { registerInit } = await import("../src/commands/init.js")
    const program = new Command().exitOverride()
    registerInit(program)
    const flags = ["--defaults", "--no-install", "--no-keys", "--admin-email", email, "--admin-password", "correct-horse"]
    await program.parseAsync(["node", "supatype", "init", join(root, "formflow"), ...flags])
  }

  it("is refused, before anything is written, when it is not one address", async () => {
    await expect(init(PASTED)).rejects.toThrow("exit 1")
    expect(existsSync(join(root, "formflow"))).toBe(false)
    expect(asked.errors.join("\n")).toMatch(/--admin-email/)
    expect(asked.errors.join("\n")).not.toContain("correct-horse")
  })
})
