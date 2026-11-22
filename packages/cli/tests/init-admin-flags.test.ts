import { afterEach, describe, expect, it, vi } from "vitest"
import { applyAdminFlags, type InitCliOptions, type WizardResult } from "../src/commands/init.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * S-21: `init --admin-email a@b.c` without `--admin-password` wrote no admin and said nothing. An
 * admin needs both, so naming one without the other is refused before anything is written.
 */
const answers = (): WizardResult => ({ projectName: "acme" }) as WizardResult

const said: string[] = []
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (message: string) => said.push(message),
}))

const flags = (more: Partial<InitCliOptions>): InitCliOptions => ({ mode: "later", install: true, keys: true, ...more })

afterEach(() => {
  said.length = 0
  vi.restoreAllMocks()
})

describe("init's admin flags", () => {
  it("refuses an email with no password, saying what is missing", () => {
    exitThrows()
    expect(() => applyAdminFlags(answers(), flags({ adminEmail: "a@example.com" }))).toThrow("exit 1")
    expect(said.join(" ")).toContain("--admin-password")
  })

  it("refuses a password with no email", () => {
    exitThrows()
    expect(() => applyAdminFlags(answers(), flags({ adminPassword: "a-long-enough-password" }))).toThrow("exit 1")
    expect(said.join(" ")).toContain("--admin-email")
  })

  it("takes both together", () => {
    const result = answers()
    applyAdminFlags(result, flags({ adminEmail: "a@example.com", adminPassword: "a-long-enough-password" }))
    expect(result.adminEmail).toBe("a@example.com")
  })

  it("--no-admin wins over both", () => {
    const result = { ...answers(), adminEmail: "x@example.com" }
    applyAdminFlags(result, flags({ admin: false, adminEmail: "a@example.com" }))
    expect(result.adminEmail).toBeUndefined()
  })
})
