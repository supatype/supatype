import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { tempProject } from "./support/command-run.js"

/**
 * `supatype link` offered http://localhost:18473 as the gateway URL whatever port the project's
 * own stack is on, so accepting the default linked to whichever project holds 18473.
 */
const asked = vi.hoisted(() => ({ defaultValue: undefined as string | undefined }))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => true }))
vi.mock("../src/ui/prompts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/prompts.js")>()
  return {
    ...actual,
    runClackFlow: async (run: () => Promise<unknown>) => run(),
    p: {
      ...actual.p,
      intro: () => undefined,
      select: async () => "self-host",
      text: async (opts: { defaultValue?: string }) => {
        asked.defaultValue = opts.defaultValue
        throw new Error("answered")
      },
    },
  }
})

const { runLinkAction } = await import("../src/commands/link-helpers.js")
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("link-local-url")
  scaffold(project.dir, defaultScaffoldOptions("lk"))
  appendFileSync(join(project.dir, ".env"), "\nSUPATYPE_KONG_PORT=19000\nAPI_EXTERNAL_URL=\n")
  vi.spyOn(process, "cwd").mockReturnValue(project.dir)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  project.remove()
})

describe("supatype link", () => {
  it("offers this project's own gateway as the default URL", async () => {
    await expect(runLinkAction({ apiUrl: "https://api.supatype.com" })).rejects.toThrow("answered")
    expect(asked.defaultValue).toBe("http://localhost:19000")
  })
})
